import type { Interaction } from '../../core/interaction/types.js';
import type { Message } from './types.js';

/** A consumed form answer is not an approval decision. */
export function interactionInputOutcome(
  record?: Interaction,
): 'submitted' | 'cancelled' | 'expired' | undefined {
  if (record?.kind !== 'structured_input') return undefined;
  if (record.status === 'cancelled' || record.outcome === 'cancelled') return 'cancelled';
  if (record.status === 'expired' || record.outcome === 'expired') return 'expired';
  return record.status === 'resolved' ? 'submitted' : undefined;
}

/** Durable decisions override stale tool snapshots in both timeline renderers. */
export function interactionApprovalStatus(
  record?: Interaction,
): NonNullable<Message['tools']>[string]['approvalStatus'] {
  if (record?.status === 'cancelled' || record?.status === 'expired'
    || record?.outcome === 'cancelled' || record?.outcome === 'expired') return 'cancelled';
  if (record?.outcome === 'approved' || record?.outcome === 'rejected') return record.outcome;
  return undefined;
}
