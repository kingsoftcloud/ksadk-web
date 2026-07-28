import { create } from 'zustand';
import type { PermissionMode } from '../core/run/types.js';

const STORAGE_KEY = 'ksadk.web.permission-mode';

function readPermissionMode(): PermissionMode {
  try {
    const mode = globalThis.localStorage?.getItem(STORAGE_KEY);
    return mode === 'ask' || mode === 'full' || mode === 'risk' ? mode : 'risk';
  } catch {
    // Private/locked-down storage must not make the composer unusable.
    return 'risk';
  }
}

function writePermissionMode(mode: PermissionMode) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // The in-memory selection remains valid when persistence is unavailable.
  }
}

export type PermissionStore = {
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
};

/**
 * A conversation-level default. The backend remains authoritative and may
 * impose a stricter tool policy for a deployment or tenant.
 */
export const usePermissionStore = create<PermissionStore>()((set) => ({
  permissionMode: readPermissionMode(),
  setPermissionMode: (permissionMode) => {
    writePermissionMode(permissionMode);
    set({ permissionMode });
  },
}));
