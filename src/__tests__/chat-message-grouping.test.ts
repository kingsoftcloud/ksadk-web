import { describe, expect, it } from 'vitest';

import { continuesAssistantTurn } from '../utils/chat-message-grouping.js';
import type { Message } from '../components/chat/types.js';

const message = (overrides: Partial<Message>): Message => ({
  id: String(overrides.id || 'message'),
  role: 'model',
  content: '',
  timestamp: 0,
  ...overrides,
});

describe('continuesAssistantTurn', () => {
  it('groups reasoning, tools and answer rows from the same run under one agent header', () => {
    const reasoning = message({ id: 'reasoning', invocationId: 'run-1' });
    const tool = message({ id: 'tool', invocationId: 'run-1' });

    expect(continuesAssistantTurn(reasoning, tool)).toBe(true);
  });

  it('starts a new group across user turns or distinct runs', () => {
    const previousRun = message({ id: 'answer-1', runId: 'run-1' });
    const nextRun = message({ id: 'answer-2', runId: 'run-2' });
    const user = message({ id: 'user', role: 'user', runId: 'run-1' });

    expect(continuesAssistantTurn(previousRun, nextRun)).toBe(false);
    expect(continuesAssistantTurn(user, previousRun)).toBe(false);
  });
});
