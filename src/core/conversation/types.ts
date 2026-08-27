/**
 * Provider-neutral conversation presentation contracts.
 *
 * These types mirror the frozen `conversation.ksadk.io/v1` wire contracts.
 * They contain no Studio state or provider-specific event names, so Hosted UI
 * and custom frontends can share the same decoding and replay semantics.
 */

export type ConversationCapabilityMode =
  | 'native'
  | 'translated'
  | 'degraded'
  | 'unavailable';

export type ConversationCapability = {
  name: string;
  mode: ConversationCapabilityMode;
  reason?: string | null;
};

export type ConversationSurface = {
  apiVersion: 'conversation.ksadk.io/v1';
  kind: 'ConversationSurface';
  surfaceId: string;
  sessionId: string;
  providerRef: string;
  inputs: ConversationCapability[];
  outputs: ConversationCapability[];
};

export type ConversationTextPart = {
  kind: 'text';
  text: string;
};

export type ConversationAttachmentPart = {
  kind: 'attachment';
  attachmentRef: string;
  mediaType: string;
  name?: string | null;
};

export type ConversationInputPart =
  | ConversationTextPart
  | ConversationAttachmentPart;

export type ConversationInput = {
  apiVersion: 'conversation.ksadk.io/v1';
  kind: 'ConversationInput';
  inputId: string;
  sessionId: string;
  idempotencyKey: string;
  parts: ConversationInputPart[];
  modelRef?: string | null;
  reasoning?: string | null;
  approvalMode?: 'ask' | 'risk' | 'full' | null;
  collaborationMode?: 'default' | 'plan' | null;
  goalObjective?: string | null;
  extensions?: Record<string, unknown>;
};

export type ConversationInputDraft = Omit<
  ConversationInput,
  'apiVersion' | 'kind'
> & {
  apiVersion?: 'conversation.ksadk.io/v1';
  kind?: 'ConversationInput';
};

export type ConversationSurfaceBootstrap = {
  buildId: string;
  surface: ConversationSurface;
};

export type ConversationItemKind =
  | 'user_message'
  | 'assistant_text'
  | 'reasoning'
  | 'tool_call'
  | 'approval'
  | 'progress'
  | 'plan'
  | 'goal'
  | 'artifact'
  | 'a2ui'
  | 'error'
  | 'unknown';

export type ConversationItemOperation = 'append' | 'replace' | 'completed';

export type ConversationItemLifecycle =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed';

export type ConversationItemVisibility = 'public' | 'internal' | 'hidden';

export type ConversationItem = {
  apiVersion: 'conversation.ksadk.io/v1';
  kindVersion: 1;
  itemId: string;
  parentItemId?: string | null;
  sourceEventIds: string[];
  sessionId: string;
  runId: string;
  kind: ConversationItemKind;
  operation: ConversationItemOperation;
  lifecycle: ConversationItemLifecycle;
  visibility: ConversationItemVisibility;
  payloadSchemaRef: string;
  payload: Record<string, unknown>;
  capabilityRef?: string | null;
  nativeRef: Record<string, unknown>;
};

export type ConversationItemReducerState = {
  /** Items remain in first-seen order. Equal text never collapses identities. */
  items: ConversationItem[];
  /** Serialized `(itemId, sourceEventId)` pairs used for reconnect replay. */
  appliedSources: string[];
};

export type ConversationTextPresentation = {
  id: string;
  parentId: string | null;
  runId: string;
  kind: 'user_message' | 'assistant_text' | 'reasoning';
  text: string;
  lifecycle: ConversationItemLifecycle;
};

export type ConversationFallbackCard = {
  id: string;
  title: string;
  detail: string;
  failed: boolean;
};

export type ConversationArtifact = {
  id: string;
  name: string;
  mimeType: string;
  /** Only an absolute HTTP(S) URI without embedded credentials is clickable. */
  uri: string | null;
};

/**
 * Headless, renderer-ready data. This projection never executes item payloads
 * and deliberately retains item identities for text and reasoning content.
 */
export type ConversationPresentation = {
  textItems: ConversationTextPresentation[];
  toolItems: ConversationItem[];
  approvalItems: ConversationItem[];
  structuredInputItems: ConversationItem[];
  a2uiItems: ConversationItem[];
  artifacts: ConversationArtifact[];
  fallbacks: ConversationFallbackCard[];
  runId: string;
  terminalStatus?: 'completed' | 'failed';
};

export type ConversationProjectionOptions = {
  /** Internal items are omitted from customer-facing surfaces by default. */
  includeInternal?: boolean;
};

export type ConversationClientErrorCode =
  | 'conversation_contract_mismatch'
  | 'conversation_input_unsupported'
  | 'conversation_session_mismatch'
  | 'conversation_http_error'
  | 'conversation_stream_error'
  | 'conversation_run_identity_missing'
  | 'conversation_reconnect_exhausted'
  | 'conversation_aborted';

export type ConversationClientErrorDetails = {
  status?: number;
  capability?: string;
  runId?: string;
  cursor?: number;
  cause?: unknown;
};

export type ConversationStreamResult = {
  cursor: number;
  runId: string;
  state: ConversationItemReducerState;
  presentation: ConversationPresentation;
};

export type ConversationStreamObserver = {
  onItem?: (item: ConversationItem) => void;
  onUpdate?: (result: ConversationStreamResult) => void;
};

export type ConversationFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type ConversationClientOptions = {
  fetch?: ConversationFetch;
  baseUrl?: string;
  maxReconnects?: number;
  sleep?: (delayMilliseconds: number) => Promise<void>;
  retryDelayMs?: (attempt: number) => number;
};

export type ConversationStreamTurnOptions = ConversationStreamObserver & {
  bootstrap: ConversationSurfaceBootstrap;
  input: ConversationInput;
  signal?: AbortSignal;
};
