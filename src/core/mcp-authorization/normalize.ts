import { normalizeInteraction } from '../interaction/adapters/normalize.js';
import type { McpAuthorizationSnapshot } from './types.js';
import { MCP_AUTHORIZATION_CAPABILITY } from './contract.js';
export function authorizationInteraction(raw: unknown, sessionId: string, runId?: string) {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as McpAuthorizationSnapshot;
  if (data.schema !== MCP_AUTHORIZATION_CAPABILITY.schema || !data.wait_id || !data.run_id
      || !Number.isSafeInteger(data.revision) || !Array.isArray(data.allowed_actions)
      || (runId && data.run_id !== runId)) return null;
  return normalizeInteraction({
    interactionId: data.wait_id, sessionId, runId: data.run_id,
    kind: 'custom', title: 'MCP 服务授权', message: '授权完成后将继续当前任务。',
    revision: data.revision, source: 'interaction_v1',
    status: data.status === 'resumed' ? 'resolved' : ['cancelled', 'expired', 'failed'].includes(data.status) ? data.status : 'pending',
    extensions: { mcpAuthorization: data },
  });
}
