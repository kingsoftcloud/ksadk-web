import type {
  ConversationCapability,
  ConversationCapabilityMode,
  ConversationItem,
  ConversationItemKind,
  ConversationItemLifecycle,
  ConversationItemOperation,
  ConversationItemVisibility,
  ConversationSurface,
} from './types.js';

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
 * Decode ConversationItem/v1. Future item kinds are retained as a passive
 * `unknown` card; an unknown contract version or unsafe structural field is
 * rejected instead of being guessed.
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
    visibility: (raw.visibility || 'public') as ConversationItemVisibility,
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
