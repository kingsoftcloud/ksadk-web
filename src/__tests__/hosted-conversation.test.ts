import { describe, expect, it, vi } from 'vitest';

import {
  HttpConversationClient,
  buildConversationInput,
  type ConversationSurface,
} from '../public/conversation.js';
import { dispatchRunEventToStores } from '../core/run/dispatcher.js';
import { sharedInteractionStore } from '../core/interaction/index.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';

const SURFACE: ConversationSurface = {
  apiVersion: 'conversation.ksadk.io/v1',
  kind: 'ConversationSurface',
  surfaceId: 'hosted-conversation',
  sessionId: 'session-hosted',
  providerRef: 'provider:test',
  inputs: [{ name: 'text', mode: 'native' }],
  outputs: [
    { name: 'text', mode: 'native' },
    { name: 'reasoning', mode: 'native' },
    { name: 'tool.inspect', mode: 'native' },
    { name: 'approval', mode: 'native' },
    { name: 'a2ui', mode: 'native' },
  ],
};

function item(
  itemId: string,
  sourceEventId: string,
  kind: string,
  payloadSchemaRef: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    apiVersion: 'conversation.ksadk.io/v1',
    kindVersion: 1,
    itemId,
    sourceEventIds: [sourceEventId],
    sessionId: 'session-hosted',
    runId: 'run-hosted',
    kind,
    operation: 'append',
    lifecycle: 'streaming',
    visibility: 'public',
    payloadSchemaRef,
    payload,
    nativeRef: {},
    ...overrides,
  };
}

function frame(id: number, conversationItem: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify({ conversationItem })}\n\n`;
}

function stream(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Hosted UI canonical ConversationItem projection', () => {
  it('uses one identity reducer across reconnect for text, reasoning, tool, approval and A2UI', async () => {
    const operations = [{
      version: 'v0.9',
      createSurface: { surfaceId: 'profile-form', catalogId: 'basic' },
    }];
    const initialText = item(
      'answer-1',
      'event-1',
      'assistant_text',
      'conversation.item.assistant_text/v1',
      { text: 'same text' },
    );
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('conversation:stream')) {
        return stream(frame(1, initialText));
      }
      if (url === '/api/v1/runs/run-hosted/events?after=1') {
        return stream([
          // The reconnect boundary replays the last source event. The shared
          // reducer, not the Hosted UI, owns replay idempotence.
          frame(1, initialText),
          frame(2, item(
            'answer-2',
            'event-2',
            'assistant_text',
            'conversation.item.assistant_text/v1',
            { text: 'same text' },
          )),
          frame(3, item(
            'reasoning-1',
            'event-3',
            'reasoning',
            'conversation.item.reasoning/v1',
            { text: 'inspect the workspace' },
          )),
          frame(4, item(
            'tool-1',
            'event-4',
            'tool_call',
            'conversation.item.tool-call/v1',
            {
              callId: 'call-1',
              tool: 'read_file',
              args: { path: 'README.md' },
            },
          )),
          frame(5, item(
            'tool-result-1',
            'event-5',
            'tool_call',
            'conversation.item.tool-call/v1',
            {
              callId: 'call-1',
              output: { ok: true },
            },
            { operation: 'completed', lifecycle: 'completed' },
          )),
          frame(6, item(
            'approval-item-1',
            'event-6',
            'approval',
            'conversation.item.approval/v1',
            {
              interactionId: 'approval-1',
              revision: 2,
              kind: 'command',
              prompt: 'Allow command?',
              detail: { command: 'echo safe' },
            },
            { lifecycle: 'pending' },
          )),
          frame(7, item(
            'a2ui-1',
            'event-7',
            'a2ui',
            'conversation.item.a2ui/v1',
            { data: operations },
          )),
          frame(8, item(
            'future-1',
            'event-8',
            'game_board',
            'vendor.game-board/v7',
            { html: '<script>unsafe()</script>' },
          )),
          frame(9, item(
            'run-terminal',
            'event-9',
            'progress',
            'conversation.item.progress/v1',
            {},
            { operation: 'completed', lifecycle: 'completed' },
          )),
        ].join(''));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new HttpConversationClient({
      fetch: fetcher,
      maxReconnects: 1,
      sleep: async () => {},
    });
    useSessionStore.getState().setCurrentSessionId('session-hosted');
    useMessageStore.getState().setMessages([]);
    sharedInteractionStore.clearSession('session-hosted');

    const result = await client.streamTurn({
      bootstrap: { buildId: 'build-hosted', surface: SURFACE },
      input: buildConversationInput({
        inputId: 'input-hosted',
        sessionId: 'session-hosted',
        idempotencyKey: 'turn-hosted',
        parts: [{ kind: 'text', text: 'hello' }],
      }),
      onUpdate: (snapshot) => dispatchRunEventToStores({
        type: 'conversation_snapshot',
        result: snapshot,
        sessionId: 'session-hosted',
      }),
    });

    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(result.state.items.map((entry) => entry.itemId)).toEqual([
      'answer-1',
      'answer-2',
      'reasoning-1',
      'tool-1',
      'tool-result-1',
      'approval-item-1',
      'a2ui-1',
      'future-1',
      'run-terminal',
    ]);

    const messages = useMessageStore.getState().messages;
    expect(messages.filter((message) => message.content === 'same text')).toHaveLength(2);
    expect(messages.filter((message) => message.itemId === 'answer-1')).toHaveLength(1);
    expect(messages.find((message) => message.itemId === 'reasoning-1')?.blocks)
      .toEqual([expect.objectContaining({ type: 'thinking', content: 'inspect the workspace' })]);
    expect(messages.find((message) => message.itemId === 'tool-1')?.blocks)
      .toEqual([expect.objectContaining({
        type: 'tool',
        toolName: 'read_file',
        output: expect.stringContaining('"ok": true'),
      })]);
    expect(messages.filter((message) => (
      message.itemId === 'tool-1' || message.itemId === 'tool-result-1'
    ))).toHaveLength(1);
    expect(messages.find((message) => message.itemId === 'a2ui-1')?.aguiActivity)
      .toEqual({ surfaceId: 'profile-form', messages: operations });
    // Additive kinds remain in the canonical reducer state for audit/replay,
    // but do not add a noisy unsupported-content transcript card.
    expect(messages.find((message) => message.itemId === 'future-1')).toBeUndefined();
    expect(messages.some((message) => message.content.includes('<script>'))).toBe(false);
    expect(sharedInteractionStore.get('session-hosted', 'approval-1')).toMatchObject({
      source: 'interaction_v1',
      revision: 2,
      status: 'pending',
      interactionId: 'approval-1',
    });
  });

  it.each([
    { label: 'missing', revision: {} },
    { label: 'zero', revision: { revision: 0 } },
  ])('keeps an approval with a $label durable revision read-only', async ({ revision }) => {
    const client = new HttpConversationClient({
      fetch: vi.fn(async () => stream([
        frame(1, item(
          'approval-without-revision',
          'approval-event',
          'approval',
          'conversation.item.approval/v1',
          {
            interactionId: 'approval-without-revision',
            kind: 'command',
            prompt: 'Allow command?',
            ...revision,
          },
          { lifecycle: 'pending' },
        )),
        frame(2, item(
          'run-terminal-readonly',
          'terminal-event-readonly',
          'progress',
          'conversation.item.progress/v1',
          {},
          { operation: 'completed', lifecycle: 'completed' },
        )),
      ].join(''))),
      maxReconnects: 0,
    });
    useSessionStore.getState().setCurrentSessionId('session-hosted');
    useMessageStore.getState().setMessages([]);
    sharedInteractionStore.clearSession('session-hosted');

    await client.streamTurn({
      bootstrap: { buildId: 'build-hosted', surface: SURFACE },
      input: buildConversationInput({
        inputId: 'input-readonly',
        sessionId: 'session-hosted',
        idempotencyKey: 'turn-readonly',
        parts: [{ kind: 'text', text: 'hello' }],
      }),
      onUpdate: (snapshot) => dispatchRunEventToStores({
        type: 'conversation_snapshot',
        result: snapshot,
        sessionId: 'session-hosted',
      }),
    });

    expect(sharedInteractionStore.get(
      'session-hosted',
      'approval-without-revision',
    )).toBeNull();
    expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({
      itemId: 'approval-without-revision',
      role: 'system',
      content: expect.stringContaining('read-only'),
    }));
  });
});
