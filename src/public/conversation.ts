/**
 * Headless ConversationSurface/ConversationItem v1 entrypoint.
 *
 * This module is safe to import in Node/SSR environments: it intentionally
 * has no React, DOM, transport, or application-shell dependency.
 */
export {
  ConversationItemReducer,
  createConversationItemState,
  decodeConversationItem,
  decodeConversationSurface,
  projectConversationItems,
  reduceConversationItem,
  surfacePermitsInput,
} from '../core/conversation/index.js';
export type {
  ConversationArtifact,
  ConversationCapability,
  ConversationCapabilityMode,
  ConversationFallbackCard,
  ConversationItem,
  ConversationItemKind,
  ConversationItemLifecycle,
  ConversationItemOperation,
  ConversationItemReducerState,
  ConversationItemVisibility,
  ConversationPresentation,
  ConversationProjectionOptions,
  ConversationSurface,
  ConversationTextPresentation,
} from '../core/conversation/index.js';
