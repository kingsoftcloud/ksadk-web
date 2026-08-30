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
