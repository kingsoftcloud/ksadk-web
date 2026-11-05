import type { ApprovalPolicyCapability } from '@/types/capabilities.js';

/**
 * A fixed deployment policy (single mode or Selectable === false) must not render
 * an approval selector. Legacy hosts without the capability keep today's menu.
 */
export function permissionMenuVisible(approvalPolicy?: ApprovalPolicyCapability): boolean {
  if (!approvalPolicy) return true;
  if (approvalPolicy.Selectable === false) return false;
  return Array.isArray(approvalPolicy.Modes) && approvalPolicy.Modes.length >= 2;
}
