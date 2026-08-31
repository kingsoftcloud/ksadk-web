import { describe, expect, it, vi } from 'vitest';

import {
  ConversationClientError,
  HttpConversationClient,
  buildConversationInput,
  decodeConversationInput,
  preflightConversationInput,
  type ConversationSurface,
} from '../public/conversation.js';

const SURFACE: ConversationSurface = {
  apiVersion: 'conversation.ksadk.io/v1',
  kind: 'ConversationSurface',
  surfaceId: 'surface-1',
  sessionId: 'session-1',
  providerRef: 'provider-1',
  inputs: [
    { name: 'text', mode: 'native' },
    { name: 'attachment.image', mode: 'translated' },
    { name: 'model.select', mode: 'native' },
  ],
  outputs: [{ name: 'streaming', mode: 'native' }],
};

function input() {
  return buildConversationInput({
    inputId: 'input-1',
    sessionId: 'session-1',
    idempotencyKey: 'turn-1',
    parts: [{ kind: 'text', text: 'hello' }],
    modelRef: 'model:example',
    extensions: {},
  });
}

function item(
  sourceEventId: string,
  text: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    apiVersion: 'conversation.ksadk.io/v1',
    kindVersion: 1,
    itemId: 'answer-1',
    sourceEventIds: [sourceEventId],
    sessionId: 'session-1',
    runId: 'run-1',
    kind: 'assistant_text',
    operation: 'append',
    lifecycle: 'streaming',
    visibility: 'public',
    payloadSchemaRef: 'conversation.item.assistant_text/v1',
    payload: { text },
    nativeRef: {},
    ...overrides,
  };
}

function frame(id: number, type: string, conversationItem: unknown): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ conversationItem })}\n\n`;
}

function stream(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('ConversationInput/v1', () => {
  it('builds and decodes the frozen provider-neutral input fixture', () => {
    const built = buildConversationInput({
      inputId: 'input-example',
      sessionId: 'session-example',
      idempotencyKey: 'turn-example',
      parts: [
        { kind: 'text', text: 'describe this image' },
        {
          kind: 'attachment',
          attachmentRef: 'attachment://image-example',
          mediaType: 'image/png',
          name: 'example.png',
        },
      ],
      modelRef: 'model:example',
      reasoning: 'high',
      extensions: {
        'ksadk.approval': 'risk',
        'ksadk.collaboration': 'plan',
        'ksadk.goal': 'finish the task',
        'vendor.preview': true,
      },
    });

    expect(built).toMatchObject({
      apiVersion: 'conversation.ksadk.io/v1',
      kind: 'ConversationInput',
      parts: expect.any(Array),
    });
    expect(decodeConversationInput(built)).toEqual(built);
  });

  it('rejects unknown or provider-specific fields instead of forwarding them', () => {
    expect(decodeConversationInput({
      ...input(),
      apiKey: 'must-not-pass',
    })).toBeNull();
    expect(() => buildConversationInput({
      inputId: 'bad',
      sessionId: 'session-1',
      idempotencyKey: 'bad',
      parts: [{ kind: 'text', text: 'hello' }],
      extensions: { unnamespaced: true },
    })).toThrowError(expect.objectContaining({ code: 'conversation_contract_mismatch' }));
  });

  it('preflights session and every optional input against the active surface', () => {
    expect(preflightConversationInput(SURFACE, input())).toEqual(input());
    expect(() => preflightConversationInput(
      { ...SURFACE, inputs: [{ name: 'text', mode: 'native' }] },
      input(),
    )).toThrowError(expect.objectContaining({
      code: 'conversation_input_unsupported',
      capability: 'model.select',
    }));
    expect(() => preflightConversationInput(
      SURFACE,
      { ...input(), sessionId: 'other-session' },
    )).toThrowError(expect.objectContaining({ code: 'conversation_session_mismatch' }));
  });
});

describe('HttpConversationClient', () => {
  it('gets a typed surface without adding credential-bearing request options', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.credentials).toBeUndefined();
      expect(init?.headers).toBeUndefined();
      return new Response(JSON.stringify({ buildId: 'build-1', surface: SURFACE }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new HttpConversationClient({ fetch: fetcher });

    await expect(client.getSurface('agent-1', 'session-1')).resolves.toEqual({
      buildId: 'build-1',
      surface: SURFACE,
    });
  });

  it('POSTs once, then resumes by cursor and canonical item run id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/v1/builds/build-1/conversation:stream') {
        return stream(frame(1, 'message.delta', item('source-1', 'hello')));
      }
      if (url === '/api/v1/runs/run-1/events?after=1') {
        return stream([
          frame(1, 'message.delta', item('source-1', 'hello')),
          frame(2, 'message.delta', item('source-2', ' world')),
          frame(3, 'run.completed', item('source-3', '', {
            itemId: 'run-end',
            kind: 'progress',
            operation: 'completed',
            lifecycle: 'completed',
            payloadSchemaRef: 'conversation.item.progress/v1',
            payload: {},
          })),
        ].join(''));
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new HttpConversationClient({
      fetch: fetcher,
      maxReconnects: 2,
      sleep: async () => {},
    });

    const result = await client.streamTurn({
      bootstrap: { buildId: 'build-1', surface: SURFACE },
      input: input(),
    });

    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/v1/builds/build-1/conversation:stream',
      '/api/v1/runs/run-1/events?after=1',
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'turn-1',
      },
    });
    expect(calls[0]?.init?.credentials).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ input: input() });
    expect(calls[1]?.init).toMatchObject({
      method: 'GET',
      headers: { 'Last-Event-ID': '1' },
    });
    expect(result.cursor).toBe(3);
    expect(result.runId).toBe('run-1');
    expect(result.presentation.textItems[0]?.text).toBe('hello world');
    expect(result.presentation.terminalStatus).toBe('completed');
  });

  it('fails typed when a stream ends before a canonical item supplies run identity', async () => {
    const fetcher = vi.fn(async () => stream(
      'id: 1\nevent: run.created\ndata: {"runId":"not-authoritative-here"}\n\n',
    ));
    const client = new HttpConversationClient({ fetch: fetcher, sleep: async () => {} });

    await expect(client.streamTurn({
      bootstrap: { buildId: 'build-1', surface: SURFACE },
      input: input(),
    })).rejects.toMatchObject({ code: 'conversation_run_identity_missing' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops at the retry limit without ever repeating the POST', async () => {
    const fetcher = vi.fn(async (url: string) => (
      url.includes('conversation:stream')
        ? stream(frame(1, 'message.delta', item('source-1', 'partial')))
        : stream('')
    ));
    const client = new HttpConversationClient({
      fetch: fetcher,
      maxReconnects: 2,
      sleep: async () => {},
    });

    await expect(client.streamTurn({
      bootstrap: { buildId: 'build-1', surface: SURFACE },
      input: input(),
    })).rejects.toMatchObject({
      code: 'conversation_reconnect_exhausted',
      runId: 'run-1',
      cursor: 1,
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports abort and HTTP failures as typed errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new HttpConversationClient({ fetch: vi.fn(), sleep: async () => {} });
    await expect(client.streamTurn({
      bootstrap: { buildId: 'build-1', surface: SURFACE },
      input: input(),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'conversation_aborted' });

    const failed = new HttpConversationClient({
      fetch: vi.fn(async () => new Response('unavailable', { status: 503 })),
    });
    await expect(failed.getSurface('agent-1', 'session-1')).rejects.toEqual(
      expect.objectContaining<Partial<ConversationClientError>>({
        code: 'conversation_http_error',
        status: 503,
      }),
    );
  });

  it('aborts while waiting to reconnect instead of starting another request', async () => {
    const controller = new AbortController();
    let notifySleepStarted = () => {};
    const sleepStarted = new Promise<void>((resolve) => {
      notifySleepStarted = resolve;
    });
    const fetcher = vi.fn(async () => stream(
      frame(1, 'message.delta', item('source-1', 'partial')),
    ));
    const client = new HttpConversationClient({
      fetch: fetcher,
      sleep: async () => {
        notifySleepStarted();
        await new Promise<void>(() => {});
      },
    });
    const turn = client.streamTurn({
      bootstrap: { buildId: 'build-1', surface: SURFACE },
      input: input(),
      signal: controller.signal,
    });
    await sleepStarted;
    controller.abort();

    await expect(turn).rejects.toMatchObject({ code: 'conversation_aborted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
