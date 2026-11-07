/**
 * AG-UI transport adapter.
 *
 * Normalizes an AG-UI interrupt-driven approval request (RunEvent
 * `approval_requested` with protocol `ag-ui`, or an AG-UI interrupt
 * payload) into the shared Interaction shape. The original interrupt id
 * is preserved in `extensions.interrupt_id` so the 0.3.1
 * `resumeAguiInterrupt` fallback still works for servers that do not
 * advertise `interaction_v1`.
 */
import type { Interaction } from '../types.js';
import { normalizeInteraction } from './normalize.js';

export type AguiInterruptRequest = {
  interruptId: string;
  sessionId: string;
  runId?: string | null;
  toolCallId?: string | null;
  name?: string;
  message?: string;
  reason?: string;
  requestSchema?: Record<string, unknown> | null;
};

export function interactionFromAguiInterrupt(
  request: AguiInterruptRequest,
): Interaction | null {
  if (!request.interruptId || !request.sessionId) return null;
  const isInput = request.requestSchema != null;
  return normalizeInteraction({
    interactionId: request.interruptId,
    sessionId: request.sessionId,
    runId: request.runId ?? null,
    kind: isInput ? 'structured_input' : 'approval',
    title: request.name ? `${isInput ? '补充信息' : '确认'}：${request.name}` : isInput ? '补充信息' : '人工确认',
    message: request.message || (isInput ? '请填写后提交，Agent 将继续当前任务。' : '本次运行需要人工确认后才能继续。'),
    requestSchema: request.requestSchema ?? null,
    status: 'pending',
    revision: 1,
    source: 'agui',
    extensions: {
      interrupt_id: request.interruptId,
      ...(request.toolCallId ? { tool_call_id: request.toolCallId } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    },
  });
}
