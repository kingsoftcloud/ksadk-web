import type {
  ConversationCapability,
  ConversationCapabilityMode,
  ConversationItem,
  ConversationItemKind,
  ConversationItemLifecycle,
  ConversationItemOperation,
  ConversationItemVisibility,
  ConversationSurface,
  ConversationInput,
  ConversationInputDraft,
  ConversationInputPart,
} from './types.js';
import { ConversationClientError } from './errors.js';

const API_VERSION = 'conversation.ksadk.io/v1';
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const CAPABILITY_MODES: ReadonlySet<ConversationCapabilityMode> = new Set([
  'native',
  'translated',
  'degraded',
  'unavailable',
]);
const ITEM_KINDS: ReadonlySet<ConversationItemKind> = new Set([
  'user_message',
  'assistant_text',
  'reasoning',
  'tool_call',
  'approval',
  'progress',
  'plan',
  'goal',
  'artifact',
  'a2ui',
  'error',
  'unknown',
]);
const OPERATIONS: ReadonlySet<ConversationItemOperation> = new Set([
  'append',
  'replace',
  'completed',
]);
const LIFECYCLES: ReadonlySet<ConversationItemLifecycle> = new Set([
  'pending',
  'streaming',
  'completed',
  'failed',
]);
const VISIBILITIES: ReadonlySet<ConversationItemVisibility> = new Set([
  'public',
  'internal',
  'hidden',
]);
const INPUT_KEYS = new Set([
  'apiVersion',
  'kind',
  'inputId',
  'sessionId',
  'idempotencyKey',
  'parts',
  'modelRef',
  'reasoning',
  'extensions',
]);
const TEXT_PART_KEYS = new Set(['kind', 'text']);
const ATTACHMENT_PART_KEYS = new Set([
  'kind',
  'attachmentRef',
  'mediaType',
  'name',
]);
const APPROVAL_MODE_EXTENSION = 'ksadk.approval';
const COLLABORATION_MODE_EXTENSION = 'ksadk.collaboration';
const GOAL_OBJECTIVE_EXTENSION = 'ksadk.goal';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string | null | undefined {
  return value === undefined
    || value === null
    || (typeof value === 'string'
      && value.length <= maxLength
      && (allowEmpty || value.length > 0));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function decodeInputPart(value: unknown): ConversationInputPart | null {
  const part = record(value);
  if (!part || typeof part.kind !== 'string') return null;
  if (part.kind === 'text') {
    if (!hasOnlyKeys(part, TEXT_PART_KEYS) || !boundedString(part.text, 131_072)) {
      return null;
    }
    return { kind: 'text', text: part.text };
  }
  if (part.kind === 'attachment') {
    if (!hasOnlyKeys(part, ATTACHMENT_PART_KEYS)
      || !boundedString(part.attachmentRef, 2_048)
      || !boundedString(part.mediaType, 256)
      || !optionalBoundedString(part.name, 1_024, true)) {
      return null;
    }
    return {
      kind: 'attachment',
      attachmentRef: part.attachmentRef,
      mediaType: part.mediaType,
      ...(part.name === undefined ? {} : { name: part.name as string | null }),
    };
  }
  return null;
}

function decodeExtensions(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  const extensions = record(value);
  if (!extensions || Object.keys(extensions).some((key) => (
    !CAPABILITY_NAME.test(key) || !key.includes('.')
  ))) {
    return null;
  }
  const approval = extensions[APPROVAL_MODE_EXTENSION];
  const collaboration = extensions[COLLABORATION_MODE_EXTENSION];
  const goal = extensions[GOAL_OBJECTIVE_EXTENSION];
  if ((approval !== undefined && !['ask', 'risk', 'full'].includes(String(approval)))
    || (collaboration !== undefined && !['default', 'plan'].includes(String(collaboration)))
    || (goal !== undefined && !boundedString(goal, 4_096))) {
    return null;
  }
  return { ...extensions };
}

/** Decode the strict, provider-neutral ConversationInput/v1 contract. */
export function decodeConversationInput(value: unknown): ConversationInput | null {
  const raw = record(value);
  if (!raw
    || !hasOnlyKeys(raw, INPUT_KEYS)
    || raw.apiVersion !== API_VERSION
    || raw.kind !== 'ConversationInput'
    || !boundedString(raw.inputId, 256)
    || !boundedString(raw.sessionId, 256)
    || !boundedString(raw.idempotencyKey, 512)
    || !Array.isArray(raw.parts)
    || raw.parts.length === 0
    || !optionalBoundedString(raw.modelRef, 256)
    || !optionalBoundedString(raw.reasoning, 64)) {
    return null;
  }
  const parts = raw.parts.map(decodeInputPart);
  const extensions = decodeExtensions(raw.extensions);
  if (parts.some((part) => part === null) || extensions === null) return null;
  return {
    apiVersion: API_VERSION,
    kind: 'ConversationInput',
    inputId: raw.inputId,
    sessionId: raw.sessionId,
    idempotencyKey: raw.idempotencyKey,
    parts: parts as ConversationInputPart[],
    ...(raw.modelRef === undefined ? {} : { modelRef: raw.modelRef as string | null }),
    ...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning as string | null }),
    ...(raw.extensions === undefined ? {} : { extensions }),
  };
}

/** Build only the frozen contract fields; callers must supply all identities. */
export function buildConversationInput(draft: ConversationInputDraft): ConversationInput {
  const decoded = decodeConversationInput({
    ...draft,
    apiVersion: draft.apiVersion || API_VERSION,
    kind: draft.kind || 'ConversationInput',
  });
  if (!decoded) {
    throw new ConversationClientError(
      'conversation_contract_mismatch',
      'Conversation input does not match conversation.ksadk.io/v1.',
    );
  }
  return decoded;
}

function requiredInputCapabilities(input: ConversationInput): string[] {
  const capabilities: string[] = input.parts.map((part) => (
    part.kind === 'text'
      ? 'text'
      : part.mediaType.toLowerCase().startsWith('image/')
        ? 'attachment.image'
        : 'attachment.file'
  ));
  if (input.modelRef) capabilities.push('model.select');
  if (input.reasoning) capabilities.push('reasoning.effort');
  for (const key of Object.keys(input.extensions || {})) {
    if (key === APPROVAL_MODE_EXTENSION) capabilities.push('approval');
    else if (key === COLLABORATION_MODE_EXTENSION) {
      if (input.extensions?.[key] === 'plan') capabilities.push('plan');
    } else if (key === GOAL_OBJECTIVE_EXTENSION) capabilities.push('goal');
    else capabilities.push(key);
  }
  return [...new Set(capabilities)];
}

/** Enforce the active Surface before any network request is created. */
export function preflightConversationInput(
  surface: ConversationSurface,
  input: ConversationInput,
): ConversationInput {
  if (surface.sessionId !== input.sessionId) {
    throw new ConversationClientError(
      'conversation_session_mismatch',
      'Conversation input session does not match the active surface.',
    );
  }
  for (const capability of requiredInputCapabilities(input)) {
    if (!surfacePermitsInput(surface, capability)) {
      throw new ConversationClientError(
        'conversation_input_unsupported',
        'Conversation input is not declared by the active surface.',
        { capability },
      );
    }
  }
  return input;
}

function decodeCapability(value: unknown): ConversationCapability | null {
  const capability = record(value);
  if (!capability
    || !boundedString(capability.name, 128)
    || !CAPABILITY_NAME.test(capability.name)
    || !CAPABILITY_MODES.has(capability.mode as ConversationCapabilityMode)
    || !optionalBoundedString(capability.reason, 512, true)) {
    return null;
  }
  if ((capability.mode === 'degraded' || capability.mode === 'unavailable')
    && !boundedString(capability.reason, 512)) {
    return null;
  }
  return {
    name: capability.name,
    mode: capability.mode as ConversationCapabilityMode,
    ...(capability.reason === undefined
      ? {}
      : { reason: capability.reason as string | null }),
  };
}

function decodeCapabilities(value: unknown): ConversationCapability[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const decoded = value.map(decodeCapability);
  if (decoded.some((capability) => capability === null)) return null;
  const capabilities = decoded as ConversationCapability[];
  const names = new Set(capabilities.map((capability) => capability.name));
  return names.size === capabilities.length ? capabilities : null;
}

/** Decode the frozen ConversationSurface/v1 contract without guessing controls. */
export function decodeConversationSurface(value: unknown): ConversationSurface | null {
  const raw = record(value);
  if (!raw
    || raw.apiVersion !== API_VERSION
    || raw.kind !== 'ConversationSurface'
    || !boundedString(raw.surfaceId, 256)
    || !boundedString(raw.sessionId, 256)
    || !boundedString(raw.providerRef, 256)) {
    return null;
  }
  const inputs = decodeCapabilities(raw.inputs);
  const outputs = decodeCapabilities(raw.outputs);
  if (!inputs || !outputs) return null;
  return {
    apiVersion: API_VERSION,
    kind: 'ConversationSurface',
    surfaceId: raw.surfaceId,
    sessionId: raw.sessionId,
    providerRef: raw.providerRef,
    inputs,
    outputs,
  };
}

/**
 * Decode ConversationItem/v1. Future item kinds remain inspectable in the
 * canonical stream but are hidden from the default transcript.  A client must
 * never turn an additive provider event into a repeating user-facing fallback
 * card. Unknown contract versions or unsafe structural fields are rejected
 * instead of being guessed.
 */
export function decodeConversationItem(value: unknown): ConversationItem | null {
  const raw = record(value);
  if (!raw
    || raw.apiVersion !== API_VERSION
    || raw.kindVersion !== 1
    || !boundedString(raw.itemId, 512)
    || !optionalBoundedString(raw.parentItemId, 512)
    || !Array.isArray(raw.sourceEventIds)
    || raw.sourceEventIds.length === 0
    || raw.sourceEventIds.some((source) => typeof source !== 'string' || source.length === 0)
    || new Set(raw.sourceEventIds).size !== raw.sourceEventIds.length
    || !boundedString(raw.sessionId, 256)
    || !boundedString(raw.runId, 256)
    || !boundedString(raw.kind, 128)
    || !OPERATIONS.has(raw.operation as ConversationItemOperation)
    || !LIFECYCLES.has(raw.lifecycle as ConversationItemLifecycle)
    || (raw.visibility !== undefined
      && !VISIBILITIES.has(raw.visibility as ConversationItemVisibility))
    || !boundedString(raw.payloadSchemaRef, 256)
    || !optionalBoundedString(raw.capabilityRef, 256, true)) {
    return null;
  }

  const operation = raw.operation as ConversationItemOperation;
  const lifecycle = raw.lifecycle as ConversationItemLifecycle;
  if (operation === 'completed'
    && lifecycle !== 'completed'
    && lifecycle !== 'failed') {
    return null;
  }

  const payload = raw.payload === undefined ? {} : record(raw.payload);
  const nativeRef = raw.nativeRef === undefined ? {} : record(raw.nativeRef);
  if (!payload || !nativeRef) return null;

  const originalKind = String(raw.kind || 'unknown');
  const kind = ITEM_KINDS.has(originalKind as ConversationItemKind)
    ? originalKind as ConversationItemKind
    : 'unknown';
  return {
    apiVersion: API_VERSION,
    kindVersion: 1,
    itemId: raw.itemId,
    ...(raw.parentItemId === undefined
      ? {}
      : { parentItemId: raw.parentItemId as string | null }),
    sourceEventIds: [...raw.sourceEventIds] as string[],
    sessionId: raw.sessionId,
    runId: raw.runId,
    kind,
    operation,
    lifecycle,
    // Keep the raw source item for replay/audit while matching the backend
    // projector: an additive, unregistered kind is not a chat card. Known
    // kinds with a newer payload schema remain visible as a single passive
    // fallback, so a schema upgrade is diagnosable without executing it.
    visibility: kind === 'unknown' && originalKind !== 'unknown'
      ? 'hidden'
      : (raw.visibility || 'public') as ConversationItemVisibility,
    payloadSchemaRef: raw.payloadSchemaRef,
    payload: kind === 'unknown' && originalKind !== 'unknown'
      ? {
          originalKind,
          summary: 'This content type is not supported by the current renderer.',
        }
      : { ...payload },
    ...(raw.capabilityRef === undefined
      ? {}
      : { capabilityRef: raw.capabilityRef as string | null }),
    nativeRef: { ...nativeRef },
  };
}

/** Whether this surface allows the browser to submit any of the named inputs. */
export function surfacePermitsInput(
  surface: ConversationSurface,
  ...names: string[]
): boolean {
  return surface.inputs.some((capability) => (
    names.includes(capability.name)
    && (capability.mode === 'native' || capability.mode === 'translated')
  ));
}
