import type {
  ConversationItem,
  ConversationItemReducerState,
} from './types.js';

export function createConversationItemState(): ConversationItemReducerState {
  return { items: [], appliedSources: [] };
}

function terminal(item: ConversationItem): boolean {
  return item.lifecycle === 'completed' || item.lifecycle === 'failed';
}

function appendPayload(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...previous, ...incoming };
  if (typeof previous.text === 'string' && typeof incoming.text === 'string') {
    payload.text = previous.text + incoming.text;
  }
  for (const key of ['data', 'operations'] as const) {
    if (Array.isArray(previous[key]) && Array.isArray(incoming[key])) {
      payload[key] = [...previous[key], ...incoming[key]];
    }
  }
  return payload;
}

/**
 * Apply one item operation using wire identity only.
 *
 * Reconnect replay is idempotent per `(itemId, sourceEventId)`. The reducer
 * never compares authors or payload text, so two items with identical content
 * remain distinct. Once an item is terminal, a late streaming replay cannot
 * make it non-terminal again.
 */
export function reduceConversationItem(
  state: ConversationItemReducerState,
  incoming: ConversationItem,
): ConversationItemReducerState {
  const sourceKeys = incoming.sourceEventIds.map(
    // JSON encodes the tuple boundaries, unlike delimiter concatenation where
    // a valid identifier containing the delimiter can collide with another
    // `(itemId, sourceEventId)` pair.
    (source) => JSON.stringify([incoming.itemId, source]),
  );
  const seen = new Set(state.appliedSources);
  if (sourceKeys.every((key) => seen.has(key))) return state;
  sourceKeys.forEach((key) => seen.add(key));

  const index = state.items.findIndex((item) => item.itemId === incoming.itemId);
  const previous = index >= 0 ? state.items[index] : undefined;
  if (previous && terminal(previous) && !terminal(incoming)) {
    return { ...state, appliedSources: [...seen] };
  }

  const items = [...state.items];
  if (!previous) {
    items.push(incoming);
  } else {
    const sourceEventIds = [
      ...new Set([...previous.sourceEventIds, ...incoming.sourceEventIds]),
    ];
    if (previous.kind !== incoming.kind) {
      items[index] = {
        ...incoming,
        kind: 'unknown',
        operation: 'replace',
        payloadSchemaRef: 'conversation.item.unknown/v1',
        payload: {
          summary: 'The content type changed for the same item and was safely degraded.',
        },
        sourceEventIds,
      };
    } else if (incoming.operation === 'append') {
      items[index] = {
        ...incoming,
        payload: appendPayload(previous.payload, incoming.payload),
        sourceEventIds,
      };
    } else {
      items[index] = { ...incoming, sourceEventIds };
    }
  }
  return { items, appliedSources: [...seen] };
}

/** Small stateful facade for applications that do not keep their own store. */
export class ConversationItemReducer {
  private state: ConversationItemReducerState = createConversationItemState();

  apply(item: ConversationItem): boolean {
    const next = reduceConversationItem(this.state, item);
    if (next === this.state) return false;
    const changed = next.items !== this.state.items;
    this.state = next;
    return changed;
  }

  applyAll(items: Iterable<ConversationItem>): void {
    for (const item of items) this.apply(item);
  }

  snapshot(): ConversationItemReducerState {
    return {
      items: this.state.items.map((item) => ({
        ...item,
        sourceEventIds: [...item.sourceEventIds],
        payload: { ...item.payload },
        nativeRef: { ...item.nativeRef },
      })),
      appliedSources: [...this.state.appliedSources],
    };
  }
}
