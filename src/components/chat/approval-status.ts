import type { Interaction } from '../../core/interaction/types.js';
import type { Message } from './types.js';

/** Durable decisions override stale tool snapshots in both timeline renderers. */
export function interactionApprovalStatus(
  record?: Interaction,
): NonNullable<Message['tools']>[string]['approvalStatus'] {
  if (record?.status === 'cancelled' || record?.status === 'expired'
    || record?.outcome === 'cancelled' || record?.outcome === 'expired') return 'cancelled';
  if (record?.outcome === 'approved' || record?.outcome === 'rejected') return record.outcome;
  return undefined;
}
