import type { Message } from '../../components/chat/types.js';
import { interactionFromAguiInterrupt } from './adapters/agui.js';
import { interactionFromResponsesApproval } from './adapters/responses.js';
import type { InteractionStore } from './store.js';
import { isTerminalInteraction } from './types.js';

type LegacyTool = NonNullable<Message['tools']>[string];
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** Recover old ToolEvents/Blocks without inventing a canonical revision or issuing a decision. */
export function restoreLegacyApprovals(
  store: InteractionStore,
  sessionId: string,
  messages: readonly Message[],
): void {
  for (const message of messages) {
    if (message.agentBlock) restoreLegacyApprovals(store, sessionId, message.agentBlock.messages);
    // Canonical approvals without a durable revision must remain read-only.
    if (message.eventType === 'conversation_item_v1') continue;
    const tools = Object.values(message.tools || {});
    const snapshots: LegacyTool[] = [...tools];
    for (const block of message.blocks || []) {
      if (block.type !== 'tool' || !text(block.extra?.approvalRequestId)) continue;
      const extra = block.extra || {};
      const tool = tools.find(entry => entry.approvalRequestId === extra.approvalRequestId);
      snapshots.push({
        ...tool,
        name: block.toolName,
        args: block.args,
        status: block.status,
        approvalRequestId: text(extra.approvalRequestId),
        approvalStatus: (text(extra.approvalStatus) || tool?.approvalStatus) as LegacyTool['approvalStatus'],
        approvalProtocol: (text(extra.approvalProtocol) || tool?.approvalProtocol) as LegacyTool['approvalProtocol'],
        approvalMessage: text(extra.approvalMessage) || tool?.approvalMessage,
        previousResponseId: text(extra.previousResponseId) || tool?.previousResponseId,
      });
    }
    for (const tool of snapshots) {
      const id = tool.approvalRequestId;
      const protocol = tool.approvalProtocol;
      const status = tool.approvalStatus || (tool.status === 'paused' ? 'pending' : undefined);
      if (!id || !status || !['pending', 'approved', 'rejected', 'cancelled'].includes(status)
        || (protocol !== 'responses' && protocol !== 'ag-ui')) continue;
      const existing = store.get(sessionId, id);
      // Event facts and accepted decisions take precedence over stale message snapshots.
      if (existing && (existing.source === 'interaction_v1' || isTerminalInteraction(existing.status))) continue;
      const request = {
        sessionId, runId: message.runId || message.invocationId,
        name: tool.name, message: tool.approvalMessage, args: tool.args,
        previousResponseId: tool.previousResponseId || message.responseId,
      };
      const interaction = protocol === 'ag-ui'
        ? interactionFromAguiInterrupt({ ...request, interruptId: id, toolCallId: tool.callId })
        : interactionFromResponsesApproval({ ...request, approvalRequestId: id });
      if (!interaction) continue;
      interaction.revision = existing?.revision || interaction.revision;
      interaction.createdAt = existing?.createdAt || interaction.createdAt;
      interaction.runId = existing?.runId || interaction.runId;
      interaction.extensions = { ...interaction.extensions, ...existing?.extensions };
      if (status !== 'pending') {
        interaction.status = status === 'cancelled' ? 'cancelled' : 'resolved';
        interaction.outcome = status;
      }
      store.upsert(interaction);
    }
  }
}
