import type {
  ConversationArtifact,
  ConversationItem,
  ConversationItemKind,
  ConversationItemReducerState,
  ConversationPresentation,
  ConversationProjectionOptions,
  ConversationTextPresentation,
  ConversationTimelineEntry,
} from './types.js';

const SUPPORTED_SCHEMAS: Partial<Record<ConversationItemKind, string>> = {
  user_message: 'conversation.item.user_message/v1',
  assistant_text: 'conversation.item.assistant_text/v1',
  reasoning: 'conversation.item.reasoning/v1',
  tool_call: 'conversation.item.tool-call/v1',
  approval: 'conversation.item.approval/v1',
  artifact: 'conversation.item.artifact/v1',
  a2ui: 'conversation.item.a2ui/v1',
  error: 'conversation.item.error/v1',
};

function terminal(item: ConversationItem): boolean {
  return item.lifecycle === 'completed' || item.lifecycle === 'failed';
}

function schemaSupported(item: ConversationItem): boolean {
  const expected = SUPPORTED_SCHEMAS[item.kind];
  return expected === undefined || expected === item.payloadSchemaRef;
}

function safeArtifactUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function projectTextItem(item: ConversationItem): ConversationTextPresentation {
  return {
    id: item.itemId,
    parentId: item.parentItemId || null,
    runId: item.runId,
    kind: item.kind as ConversationTextPresentation['kind'],
    text: typeof item.payload.text === 'string' ? item.payload.text : '',
    lifecycle: item.lifecycle,
  };
}

function projectArtifact(item: ConversationItem): ConversationArtifact {
  return {
    id: item.itemId,
    name: typeof item.payload.name === 'string' && item.payload.name
      ? item.payload.name
      : 'Artifact',
    mimeType: typeof item.payload.mimeType === 'string' && item.payload.mimeType
      ? item.payload.mimeType
      : 'application/octet-stream',
    uri: safeArtifactUri(item.payload.uri),
  };
}

function payloadString(item: ConversationItem, field: string): string | null {
  const value = item.payload[field];
  return typeof value === 'string' && value ? value : null;
}

function presentationKey(item: ConversationItem): string {
  if (item.kind === 'tool_call') {
    const callId = payloadString(item, 'callId');
    if (callId) return `tool:${callId}`;
  }
  if (item.kind === 'approval') {
    const interactionId = payloadString(item, 'interactionId');
    if (interactionId) return `approval:${interactionId}`;
  }
  if (item.kind === 'a2ui') {
    const surfaceId = payloadString(item, 'surfaceId');
    if (surfaceId) return `a2ui:${surfaceId}`;
  }
  return `item:${item.itemId}`;
}

function mergeTimelineItem(
  previous: ConversationItem,
  incoming: ConversationItem,
): ConversationItem {
  const preserveTerminal = terminal(previous) && !terminal(incoming);
  return {
    ...previous,
    ...incoming,
    itemId: previous.itemId,
    parentItemId: previous.parentItemId,
    sourceEventIds: [...new Set([...previous.sourceEventIds, ...incoming.sourceEventIds])],
    payload: { ...previous.payload, ...incoming.payload },
    nativeRef: { ...previous.nativeRef, ...incoming.nativeRef },
    ...(preserveTerminal ? { lifecycle: previous.lifecycle, operation: previous.operation } : {}),
  };
}

function projectTimeline(items: ConversationItem[]): ConversationTimelineEntry[] {
  const entries: ConversationTimelineEntry[] = [];
  const indices = new Map<string, number>();
  for (const item of items) {
    const key = presentationKey(item);
    const index = indices.get(key);
    if (index === undefined) {
      indices.set(key, entries.length);
      entries.push({ key, item, sourceItemIds: [item.itemId] });
      continue;
    }
    const previous = entries[index];
    entries[index] = {
      key,
      item: mergeTimelineItem(previous.item, item),
      sourceItemIds: [...new Set([...previous.sourceItemIds, item.itemId])],
    };
  }
  return entries;
}

/**
 * Produce passive renderer data. Unknown kinds or payload schema versions are
 * converted to fallback cards; A2UI and approvals remain typed data and are
 * never executed by this projection.
 */
export function projectConversationItems(
  state: ConversationItemReducerState,
  options: ConversationProjectionOptions = {},
): ConversationPresentation {
  const visible = state.items.filter((item) => (
    item.visibility === 'public'
    || (options.includeInternal === true && item.visibility === 'internal')
  ));
  const supported = visible.filter(schemaSupported);
  const unsupported = visible.filter((item) => !schemaSupported(item));
  const textKinds: ReadonlySet<ConversationItemKind> = new Set([
    'user_message',
    'assistant_text',
    'reasoning',
  ]);
  const textItems = supported
    .filter((item) => textKinds.has(item.kind))
    .map(projectTextItem);
  const textSummary = (kind: ConversationItemKind): string => supported
    .filter((item) => item.kind === kind)
    .map((item) => typeof item.payload.text === 'string' ? item.payload.text : '')
    .join('');
  const fallbackItems = [
    ...supported.filter((item) => item.kind === 'unknown'),
    ...unsupported,
  ];
  const failures = supported.filter((item) => item.kind === 'error');
  const terminalItem = [...supported].reverse().find((item) => (
    (item.kind === 'progress' || item.kind === 'error') && terminal(item)
  ));

  return {
    timeline: projectTimeline(supported.filter((item) => item.kind !== 'progress')),
    output: textSummary('assistant_text'),
    reasoning: textSummary('reasoning'),
    textItems,
    toolItems: supported.filter((item) => item.kind === 'tool_call'),
    approvalItems: supported.filter((item) => item.kind === 'approval'),
    structuredInputItems: supported.filter((item) => (
      item.kind === 'progress'
      && item.payloadSchemaRef === 'conversation.item.structured-input/v1'
    )),
    a2uiItems: supported.filter((item) => item.kind === 'a2ui'),
    artifacts: supported
      .filter((item) => item.kind === 'artifact')
      .map(projectArtifact),
    fallbacks: [
      ...fallbackItems.map((item) => ({
        id: item.itemId,
        title: 'Unsupported content',
        detail: String(
          item.payload.summary
          || item.payload.originalKind
          || item.payloadSchemaRef,
        ),
        failed: item.lifecycle === 'failed',
      })),
      ...failures.map((item) => ({
        id: item.itemId,
        title: 'Run failed',
        detail: String(item.payload.error || 'The agent run failed.'),
        failed: true,
      })),
    ],
    runId: visible.at(-1)?.runId || '',
    terminalStatus: terminalItem
      ? terminalItem.lifecycle === 'failed' ? 'failed' : 'completed'
      : undefined,
  };
}
