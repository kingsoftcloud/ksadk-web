import { agentBlockProfile } from './agent.js';
import { RuntimeConversationIngress } from './runtime-ingress.js';
import {
  decodeConversationItem,
  decodeConversationSurface,
  preflightConversationInput,
} from './contracts.js';
import { ConversationClientError } from './errors.js';
import {
  conversationTerminalStatus,
  projectConversationItems,
} from './presentation.js';
import { ConversationItemReducer } from './reducer.js';
import type {
  ConversationClientOptions,
  ConversationFetch,
  ConversationItem,
  ConversationStreamResult,
  ConversationStreamTurnOptions,
  ConversationSurfaceBootstrap,
} from './types.js';

const DEFAULT_MAX_RECONNECTS = 8;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function aborted(signal?: AbortSignal): never | void {
  if (signal?.aborted) {
    throw new ConversationClientError(
      'conversation_aborted',
      'Conversation request was aborted.',
    );
  }
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!baseUrl) return '';
  if (!baseUrl.includes('://')) return baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
  try {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password) {
      throw new Error('unsafe URL');
    }
    return parsed.toString().replace(/\/$/, '');
  } catch (cause) {
    throw new ConversationClientError(
      'conversation_contract_mismatch',
      'Conversation base URL must be an HTTP(S) URL without embedded credentials.',
      { cause },
    );
  }
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(200 * (2 ** Math.max(0, attempt - 1)), 2_000);
}

function defaultSleep(delayMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMilliseconds);
  });
}

async function waitForRetry(
  sleep: (delayMilliseconds: number) => Promise<void>,
  delayMilliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  aborted(signal);
  if (!signal) {
    await sleep(delayMilliseconds);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new ConversationClientError(
      'conversation_aborted',
      'Conversation request was aborted.',
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(delayMilliseconds).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function createResult(
  reducer: ConversationItemReducer,
  cursor: number,
  runId: string,
  profile?: 'flat-v1' | 'agent-block-v1',
  runtime?: RuntimeConversationIngress,
): ConversationStreamResult {
  const state = runtime ? runtime.snapshot() : reducer.snapshot();
  return {
    cursor,
    runId,
    state,
    presentation: projectConversationItems(state, {profile}),
  };
}

type StreamContext = {
  profile: 'flat-v1' | 'agent-block-v1';
  lane: 'native' | 'runtime';
  runtime: RuntimeConversationIngress;
  cursor: number;
  runId: string;
  reducer: ConversationItemReducer;
  options: ConversationStreamTurnOptions;
};

function processFrame(frame: string, context: StreamContext): void {
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new ConversationClientError(
          'conversation_stream_error',
          'Conversation stream contains an invalid replay cursor.',
        );
      }
      id = Number(value);
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return;

  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch (cause) {
    throw new ConversationClientError(
      'conversation_contract_mismatch',
      'Conversation stream contains invalid JSON.',
      { cause },
    );
  }
  const raw = object(payload);
  const runtimeFrame = object(raw?.runtimeEvent) || object(raw?.runtime_event) || (raw?.schema_version === 2 ? raw : null);
  if (!raw || (raw.conversationItem === undefined && !runtimeFrame)) {
    if (id !== undefined) context.cursor = Math.max(context.cursor, id);
    return;
  }
  if (id === undefined) {
    throw new ConversationClientError(
      'conversation_stream_error',
      'Canonical conversation items require an SSE replay cursor.',
    );
  }
  const lane = raw.conversationItem !== undefined ? 'native' : 'runtime';
  if (context.lane && context.lane !== lane) {
    context.cursor = Math.max(context.cursor, id);
    return;
  }
  let item: ConversationItem | null;
  try {
    item = lane === 'native' ? decodeConversationItem(raw.conversationItem) : context.runtime.apply(runtimeFrame!);
  } catch (cause) {
    throw new ConversationClientError('conversation_contract_mismatch', 'Runtime conversation identity or lifecycle invariant failed.', {cause});
  }
  if (lane === 'runtime' && !item) { context.cursor = Math.max(context.cursor, id); return; }
  if (!item) {
    throw new ConversationClientError(
      'conversation_contract_mismatch',
      'Conversation stream item does not match conversation.ksadk.io/v1.',
    );
  }
  if (context.runId && context.runId !== item.runId) {
    throw new ConversationClientError(
      'conversation_contract_mismatch',
      'Conversation stream changed canonical run identity.',
      { runId: context.runId, cursor: context.cursor },
    );
  }
  context.runId = item.runId;
  let changed: boolean;
  try { changed = lane === 'runtime' ? true : context.reducer.apply(item); } catch (cause) {
    throw new ConversationClientError('conversation_contract_mismatch', 'Conversation identity or lifecycle invariant failed.', {cause});
  }
  context.cursor = Math.max(context.cursor, id);
  if (
    changed
    && !(context.profile === 'flat-v1' && item.nativeRef.parentScopeId)
  ) {
    context.options.onItem?.(item);
  }
  context.options.onUpdate?.(createResult(
    context.reducer,
    context.cursor,
    context.runId,
    context.profile,
    context.lane === 'runtime' ? context.runtime : undefined,
  ));
}

async function consumeEventStream(
  response: Response,
  context: StreamContext,
): Promise<void> {
  if (!response.body) {
    throw new ConversationClientError(
      'conversation_stream_error',
      'Conversation response has no event stream body.',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      aborted(context.options.signal);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary?.index !== undefined) {
        const end = boundary.index;
        const length = boundary[0].length;
        processFrame(buffer.slice(0, end), context);
        buffer = buffer.slice(end + length);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processFrame(buffer, context);
  } catch (error) {
    if (error instanceof ConversationClientError) throw error;
    if (isAbortFailure(error, context.options.signal)) aborted(context.options.signal);
    throw new ConversationClientError(
      'conversation_stream_error',
      'Conversation event stream was interrupted.',
      { cause: error, runId: context.runId || undefined, cursor: context.cursor },
    );
  } finally {
    reader.releaseLock();
  }
}

function terminal(result: ConversationStreamResult): boolean {
  return result.state.items.some((item) => conversationTerminalStatus(item) !== undefined);
}

/**
 * Minimal HTTP/SSE reference client for ConversationSurface/Input/Item v1.
 *
 * It never accepts auth headers or credentials. Applications are expected to
 * inject a same-origin fetch implementation or an already-authenticated server
 * transport outside this protocol-neutral package.
 */
export class HttpConversationClient {
  private readonly fetcher?: ConversationFetch;
  private readonly ingressLane?: 'native' | 'runtime';
  private readonly rendererCatalog?: ConversationClientOptions['rendererCatalog'];

  private readonly baseUrl: string;

  private readonly maxReconnects: number;

  private readonly sleep: (delayMilliseconds: number) => Promise<void>;

  private readonly retryDelayMs: (attempt: number) => number;

  constructor(options: ConversationClientOptions = {}) {
    if (!Number.isInteger(options.maxReconnects ?? DEFAULT_MAX_RECONNECTS)
      || (options.maxReconnects ?? DEFAULT_MAX_RECONNECTS) < 0
      || (options.maxReconnects ?? DEFAULT_MAX_RECONNECTS) > 32) {
      throw new ConversationClientError(
        'conversation_contract_mismatch',
        'Conversation reconnect limit must be an integer from 0 to 32.',
      );
    }
    this.fetcher = options.fetch;
    this.rendererCatalog = options.rendererCatalog;
    this.ingressLane = options.ingressLane;
    this.baseUrl = normalizeBaseUrl(options.baseUrl || '');
    this.maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    this.sleep = options.sleep || defaultSleep;
    this.retryDelayMs = options.retryDelayMs || defaultRetryDelay;
  }

  private fetch(): ConversationFetch {
    if (this.fetcher) return this.fetcher;
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis) as ConversationFetch;
    }
    throw new ConversationClientError(
      'conversation_http_error',
      'No fetch implementation is available for the conversation client.',
    );
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(
    url: string,
    init: RequestInit | undefined,
    signal?: AbortSignal,
    errorCode: 'conversation_http_error' | 'conversation_stream_error' = 'conversation_stream_error',
  ): Promise<Response> {
    aborted(signal);
    try {
      return await this.fetch()(url, init);
    } catch (error) {
      if (error instanceof ConversationClientError) throw error;
      if (isAbortFailure(error, signal)) aborted(signal);
      throw new ConversationClientError(
        errorCode,
        'Conversation network request failed.',
        { cause: error },
      );
    }
  }

  private assertOk(response: Response): void {
    if (!response.ok) {
      throw new ConversationClientError(
        'conversation_http_error',
        `Conversation endpoint returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }
  }

  async getSurface(
    agentId: string,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConversationSurfaceBootstrap> {
    if (!agentId || !sessionId) {
      throw new ConversationClientError(
        'conversation_contract_mismatch',
        'Agent and session identities are required to get a conversation surface.',
      );
    }
    const init = options.signal ? { signal: options.signal } : undefined;
    const response = await this.request(this.url(
      `/api/v1/agents/${encodeURIComponent(agentId)}/conversation-surface`
      + `?sessionId=${encodeURIComponent(sessionId)}`,
    ), init, options.signal, 'conversation_http_error');
    this.assertOk(response);
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch (cause) {
      throw new ConversationClientError(
        'conversation_contract_mismatch',
        'Conversation surface response is not valid JSON.',
        { cause },
      );
    }
    const raw = object(payload);
    const surface = decodeConversationSurface(raw?.surface);
    if (!raw || typeof raw.buildId !== 'string' || !raw.buildId || !surface) {
      throw new ConversationClientError(
        'conversation_contract_mismatch',
        'Conversation surface response does not match conversation.ksadk.io/v1.',
      );
    }
    return { buildId: raw.buildId, surface };
  }

  async streamTurn(options: ConversationStreamTurnOptions): Promise<ConversationStreamResult> {
    aborted(options.signal);
    const profile = agentBlockProfile(options.bootstrap.surface, this.rendererCatalog);
    const input = {...options.input, ...((profile === 'agent-block-v1' || options.input.extensions?.['ksadk.presentation']) ? {extensions:{...options.input.extensions, 'ksadk.presentation':{profile}}} : {})};
    preflightConversationInput(options.bootstrap.surface, input);
    const agentCapability = options.bootstrap.surface.outputs.find(capability => capability.name === 'agent.block');
    const declaredLane = agentCapability?.mode === 'native' ? 'native' : agentCapability?.mode === 'translated' ? 'runtime' : undefined;
    if (declaredLane && this.ingressLane && declaredLane !== this.ingressLane) throw new ConversationClientError('conversation_contract_mismatch', 'Configured ingress lane disagrees with the conversation surface.');
    const lane = declaredLane || this.ingressLane || 'native';
    const reducer = new ConversationItemReducer();
    const context: StreamContext = {
      profile,
      lane,
      runtime: new RuntimeConversationIngress(input.sessionId, reducer, profile),
      cursor: 0,
      runId: '',
      reducer,
      options,
    };
    const postInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': options.input.idempotencyKey,
      },
      body: JSON.stringify({ input }),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const initial = await this.request(this.url(
      `/api/v1/builds/${encodeURIComponent(options.bootstrap.buildId)}/conversation:stream`,
    ), postInit, options.signal);
    this.assertOk(initial);
    try {
      await consumeEventStream(initial, context);
    } catch (error) {
      if (!(error instanceof ConversationClientError)
        || error.code !== 'conversation_stream_error'
        || !context.runId) {
        throw error;
      }
    }

    let result = createResult(
      context.reducer,
      context.cursor,
      context.runId,
      context.profile,
      context.lane === 'runtime' ? context.runtime : undefined,
    );
    if (terminal(result)) return result;
    if (!context.runId) {
      throw new ConversationClientError(
        'conversation_run_identity_missing',
        'The stream ended before a canonical item supplied its run identity.',
        { cursor: context.cursor },
      );
    }

    for (let attempt = 1; attempt <= this.maxReconnects; attempt += 1) {
      await waitForRetry(
        this.sleep,
        this.retryDelayMs(attempt),
        options.signal,
      );
      aborted(options.signal);
      let replay: Response;
      try {
        replay = await this.request(this.url(
          `/api/v1/runs/${encodeURIComponent(context.runId)}/events?after=${context.cursor}${context.profile === 'agent-block-v1' ? '&presentationProfile=agent-block-v1' : ''}`,
        ), {
          method: 'GET',
          headers: { 'Last-Event-ID': String(context.cursor) },
          ...(options.signal ? { signal: options.signal } : {}),
        }, options.signal);
        this.assertOk(replay);
        await consumeEventStream(replay, context);
      } catch (error) {
        if (error instanceof ConversationClientError
          && error.code === 'conversation_aborted') {
          throw error;
        }
        if (error instanceof ConversationClientError
          && error.code === 'conversation_contract_mismatch') {
          throw error;
        }
        if (error instanceof ConversationClientError
          && error.code === 'conversation_http_error'
          && error.status !== undefined
          && error.status < 500) {
          throw error;
        }
        continue;
      }
      result = createResult(
        context.reducer,
        context.cursor,
        context.runId,
        context.profile,
        context.lane === 'runtime' ? context.runtime : undefined,
      );
      if (terminal(result)) return result;
    }
    throw new ConversationClientError(
      'conversation_reconnect_exhausted',
      'Conversation replay stopped after the configured reconnect limit.',
      { runId: context.runId, cursor: context.cursor },
    );
  }
}

export type { ConversationItem };
