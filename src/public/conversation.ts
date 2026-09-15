/**
 * Headless ConversationSurface/ConversationItem v1 entrypoint.
 *
 * This module is safe to import in Node/SSR environments: it intentionally
 * has no React, DOM, or application-shell dependency. Its optional reference
 * transport uses only injected/global Fetch, Web Streams, and TextDecoder.
 */
export {
  ConversationItemReducer,
  ConversationClientError,
  HttpConversationClient,
  buildConversationInput,
  createConversationItemState,
  decodeConversationItem,
  decodeConversationInput,
  decodeConversationSurface,
  preflightConversationInput,
  projectConversationItems,
  reduceConversationItem,
  createTrustedRendererCatalog,
  surfacePermitsInput,
} from '../core/conversation/index.js';
export {
  persistedRuntimeFrame,
  rebuildPersistedSessionHistory,
} from '../utils/persisted-session-history.js';
export type {
  PersistedSessionEventRecord,
} from '../utils/persisted-session-history.js';
export type {
  BlockStatus,
  ProcessingBlock,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
} from '../core/run/blocks.js';
export type {
  ConversationArtifact,
  ConversationCapability,
  ConversationCapabilityMode,
  ConversationClientErrorCode,
  ConversationClientErrorDetails,
  ConversationClient,
  ConversationClientOptions,
  ConversationFetch,
  ConversationFallbackCard,
  ConversationInput,
  ConversationInputDraft,
  ConversationInputPart,
  ConversationAttachmentPart,
  ConversationItem,
  ConversationItemKind,
  ConversationItemLifecycle,
  ConversationItemOperation,
  ConversationItemReducerState,
  ConversationItemVisibility,
  ConversationPresentation,
  ConversationProjectionOptions,
  ConversationSurface,
  ConversationSurfaceBootstrap,
  ConversationStreamObserver,
  ConversationStreamResult,
  ConversationStreamTurnOptions,
  ConversationTextPart,
  ConversationTextPresentation,
  ConversationTimelineEntry,
  TrustedConversationRenderer,
  TrustedRendererCatalog,
} from '../core/conversation/index.js';
export {
  createConversationId,
  createNavigationEpoch,
  ConversationController,
  DraftStore,
  isCurrentNavigation,
} from '../core/conversation/studio-controller.js';
export { ApiSessionFacade } from '../core/conversation/session-facade.js';
export type { SessionFacade, SessionOwner, SessionSummary } from '../core/conversation/session-facade.js';
export { ConversationProjectionStore } from '../core/conversation/projection-store.js';
export type { ProjectionCheckpoint } from '../core/conversation/projection-store.js';
export { searchConversationMessages, scanConversationHistory } from '../core/conversation/history-search.js';
export type { HistorySearchMatch, HistorySearchResult } from '../core/conversation/history-search.js';
export type {
  ConversationId,
  ConversationBinding,
  DraftSession,
} from '../core/conversation/studio-controller.js';
