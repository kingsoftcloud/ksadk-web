import { normalizeInteraction } from '../interaction/adapters/normalize.js';
import type { McpAuthorizationSnapshot } from './types.js';
import { MCP_AUTHORIZATION_CAPABILITY } from './contract.js';

type WaitBinding = Pick<McpAuthorizationSnapshot, 'schema' | 'wait_id' | 'run_id' | 'revision'>;

function hasWaitBinding(raw: unknown): raw is WaitBinding & Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.schema === MCP_AUTHORIZATION_CAPABILITY.schema
    && typeof value.wait_id === 'string' && value.wait_id.length > 0
    && typeof value.run_id === 'string' && value.run_id.length > 0
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isMcpAuthorizationSnapshot(raw: unknown): raw is McpAuthorizationSnapshot {
  return hasWaitBinding(raw)
    && typeof raw.capability_digest === 'string' && typeof raw.config_id === 'string'
    && typeof raw.status === 'string' && typeof raw.deadline === 'number' && Number.isFinite(raw.deadline)
    && typeof raw.requires_resume === 'boolean'
    && (raw.display_name === undefined || typeof raw.display_name === 'string')
    && (raw.error == null || typeof raw.error === 'string')
    && isStringArray(raw.scopes) && isStringArray(raw.allowed_actions);
}

export function authorizationInteraction(raw: unknown, sessionId: string, runId?: string) {
  if (!hasWaitBinding(raw) || (runId && raw.run_id !== runId)) return null;
  // Keep a malformed event attached to its original wait for a read-only upgrade notice.
  const data = isMcpAuthorizationSnapshot(raw) && raw.capability_digest === MCP_AUTHORIZATION_CAPABILITY.digest ? raw : {
    schema: raw.schema, wait_id: raw.wait_id, run_id: raw.run_id, revision: raw.revision, status: 'unsupported',
  };
  return normalizeInteraction({
    interactionId: data.wait_id, sessionId, runId: data.run_id,
    kind: 'custom', title: 'MCP 服务授权', message: '授权完成后将继续当前任务。',
    revision: data.revision, source: 'interaction_v1',
    status: data.status === 'resumed' ? 'resolved' : ['cancelled', 'expired', 'failed'].includes(data.status) ? data.status : 'pending',
    extensions: { mcpAuthorization: data },
  });
}
