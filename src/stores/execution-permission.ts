/** Execution-sandbox selection for the Hosted UI.
 *
 * The runtime declares the modes it admits; the UI renders exactly those and
 * persists one choice per Agent. A stale persisted value never wins over the
 * current declaration: it is cleaned up when the capability arrives.
 */
import { create } from 'zustand';
import { authorizationCache } from '../utils/authorization-cache.js';
import type { ExecutionPermissionMode, ExecutionPolicyCapability } from '../types/capabilities.js';

const STORAGE_PREFIX = 'ksadk.web.execution-permission';

export const EXECUTION_PERMISSION_MODES: ExecutionPermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

export const EXECUTION_PERMISSION_LABELS: Record<ExecutionPermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

export const EXECUTION_PERMISSION_TRIGGERS: Record<ExecutionPermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

export const EXECUTION_PERMISSION_DESCRIPTIONS: Record<ExecutionPermissionMode, string> = {
  'read-only': '只读文件与命令',
  'workspace-write': '可修改工作区文件',
  'danger-full-access': '不再限制文件与命令',
};

export function normalizeExecutionModes(
  policy?: ExecutionPolicyCapability | null,
): ExecutionPermissionMode[] {
  if (!policy || !Array.isArray(policy.Modes)) return [];
  const modes = policy.Modes.filter((mode): mode is ExecutionPermissionMode =>
    EXECUTION_PERMISSION_MODES.includes(mode as ExecutionPermissionMode));
  return [...new Set(modes)];
}

/** Resolve the effective selection without ever inventing a mode the runtime did not declare. */
export function resolveExecutionMode(
  policy?: ExecutionPolicyCapability | null,
  persisted?: string | null,
): ExecutionPermissionMode | undefined {
  const modes = normalizeExecutionModes(policy);
  if (modes.length === 0) return undefined;
  if (persisted && modes.includes(persisted as ExecutionPermissionMode)) {
    return persisted as ExecutionPermissionMode;
  }
  const declaredDefault = policy?.DefaultMode;
  if (declaredDefault && modes.includes(declaredDefault)) return declaredDefault;
  return modes[0];
}

/** RunAgent metadata fragment; absent when no mode was selected or declared. */
export function executionPermissionMetadata(mode?: string | null): Record<string, string> {
  return mode ? { permission_mode: mode } : {};
}

function storageKey(agentId: string): string {
  return authorizationCache.key(`${STORAGE_PREFIX}.${agentId}`);
}

function readPersisted(agentId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(storageKey(agentId)) ?? null;
  } catch {
    return null;
  }
}

function writePersisted(agentId: string, mode: string | null): void {
  if (!authorizationCache.writable) return;
  try {
    if (mode) globalThis.localStorage?.setItem(storageKey(agentId), mode);
    else globalThis.localStorage?.removeItem(storageKey(agentId));
  } catch {
    // In-memory selection stays valid when persistence is unavailable.
  }
}

export type ExecutionPermissionStore = {
  byAgent: Record<string, ExecutionPermissionMode | undefined>;
  /** Reconcile the stored choice with the runtime declaration. */
  configure: (agentId: string, policy?: ExecutionPolicyCapability | null) => void;
  select: (agentId: string, mode: ExecutionPermissionMode) => void;
  modeFor: (agentId: string) => ExecutionPermissionMode | undefined;
};

export const useExecutionPermissionStore = create<ExecutionPermissionStore>()((set, get) => ({
  byAgent: {},
  configure: (agentId, policy) => {
    if (!agentId) return;
    const mode = resolveExecutionMode(policy, readPersisted(agentId));
    if (mode && mode !== readPersisted(agentId)) writePersisted(agentId, mode);
    if (!mode && readPersisted(agentId)) writePersisted(agentId, null);
    set((state) => ({ byAgent: { ...state.byAgent, [agentId]: mode } }));
  },
  select: (agentId, mode) => {
    if (!agentId) return;
    writePersisted(agentId, mode);
    set((state) => ({ byAgent: { ...state.byAgent, [agentId]: mode } }));
  },
  modeFor: (agentId) => get().byAgent[agentId],
}));
