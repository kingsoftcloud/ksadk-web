import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  currentSessionId: 'other-session' as string | null,
  banner: { kind: 'error', message: 'Previous approval failed', sessionId: 'failed-session' },
}));
vi.mock('../stores/streaming.js', () => ({ useStreamingStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../stores/session.js', () => ({ useSessionStore: (select: (s: typeof state) => unknown) => select(state) }));

import { StatusBanner } from '../components/chat/StatusBanner.js';

describe('session-scoped run errors', () => {
  it('shows the error only while viewing its owning session', () => {
    state.currentSessionId = 'failed-session';
    expect(renderToStaticMarkup(<StatusBanner />)).toContain('Previous approval failed');
    state.currentSessionId = 'other-session';
    expect(renderToStaticMarkup(<StatusBanner />)).not.toContain('Previous approval failed');
    state.currentSessionId = null;
    expect(renderToStaticMarkup(<StatusBanner />)).not.toContain('Previous approval failed');
    state.currentSessionId = 'failed-session';
    expect(renderToStaticMarkup(<StatusBanner />)).toContain('Previous approval failed');
  });
});
