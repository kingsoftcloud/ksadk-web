import type { Message } from '../components/chat/types.js';

type ToolFacts = Pick<NonNullable<Message['tools']>[string], 'args' | 'output' | 'status'>;
type ToolRecord = NonNullable<Message['tools']>[string];
type ToolOwner = { message: Message; key: string };

/** A partial page is not evidence that a completed tool became pending again. */
export function mergeHistoryToolFacts(previous: ToolFacts, incoming: ToolFacts): ToolFacts {
  const terminal = (status: ToolFacts['status']) => status === 'completed' || status === 'error';
  const output = incoming.output === undefined ? previous.output : incoming.output;
  return {
    args: incoming.args || previous.args,
    ...(output === undefined ? {} : { output }),
    status: terminal(previous.status) && !terminal(incoming.status) ? previous.status : incoming.status,
  };
}

/** Compatibility message pages may repeat the same cumulative call snapshot. */
export function coalesceHistoryToolCalls(messages: Message[]): Message[] {
  const mapped = messages.map(message => ({ ...message,
    tools: message.tools ? { ...message.tools } : undefined,
  }));
  const owners = new Map<string, ToolOwner>();
  const canonicalOwners = new Map<string, ToolOwner[]>();
  const scopes = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  for (const message of mapped) {
    if (!message.invocationId) continue;
    const seen = new Set<string>();
    for (const [toolKey, tool] of Object.entries(message.tools || {})) {
      if (!tool.callId || tool.approvalRequestId) continue;
      const key = JSON.stringify([message.invocationId, tool.callId]);
      if (seen.has(key)) ambiguous.add(key);
      seen.add(key);
      if (message.scopeId) {
        const known = scopes.get(key) || new Set<string>();
        known.add(message.scopeId);
        scopes.set(key, known);
      }
      if (message.itemId) canonicalOwners.set(key,
        [...(canonicalOwners.get(key) || []), { message, key: toolKey }]);
    }
  }
  const mergeInto = (owner: ToolOwner, tool: ToolRecord, preferOwner = false) => {
    const earlier = owner.message.tools![owner.key];
    const merged = preferOwner
      ? { ...tool, ...earlier, ...mergeHistoryToolFacts(tool, earlier) }
      : { ...earlier, ...tool, ...mergeHistoryToolFacts(earlier, tool) };
    owner.message.tools![owner.key] = merged;
    owner.message.blocks = owner.message.blocks?.map(block => block.type === 'tool'
      && block.extra?.callId === tool.callId
      ? { ...block, args: merged.args, output: merged.output, status: merged.status } : block);
  };
  const remove = (message: Message, key: string, callId: string) => {
    delete message.tools![key];
    message.blocks = message.blocks?.filter(block => block.type !== 'tool' || block.extra?.callId !== callId);
  };
  let changed = false;
  for (const message of [...mapped].sort((a, b) => (a.historyOrder?.seq ?? 0) - (b.historyOrder?.seq ?? 0))) {
    // Canonical item identities remain owned by the conversation projection.
    if (message.itemId || !message.invocationId) continue;
    for (const [key, tool] of Object.entries(message.tools || {})) {
      if (!tool.callId || tool.approvalRequestId) continue;
      const runCall = JSON.stringify([message.invocationId, tool.callId]);
      if (ambiguous.has(runCall)) continue;
      const canonical = (canonicalOwners.get(runCall) || [])
        .filter(owner => !message.scopeId || owner.message.scopeId === message.scopeId);
      if (canonical.length > 1) continue;
      if (canonical.length === 1) {
        mergeInto(canonical[0], tool, true);
        remove(message, key, tool.callId);
        changed = true;
        continue;
      }
      const known = scopes.get(runCall);
      const scope = message.scopeId || (known?.size === 1 ? [...known][0] : '');
      const identity = JSON.stringify([message.invocationId, scope, tool.callId]);
      const previous = owners.get(identity);
      if (!previous) {
        owners.set(identity, { message, key });
        continue;
      }
      mergeInto(previous, tool);
      remove(message, key, tool.callId);
      changed = true;
    }
  }
  return changed ? mapped : messages;
}
