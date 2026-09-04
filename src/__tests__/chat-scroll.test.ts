import { describe, expect, it } from 'vitest';

import { shouldShowScrollToBottom } from '../utils/chat-scroll.js';

describe('shouldShowScrollToBottom', () => {
  it('stays hidden at the bottom of a long transcript', () => {
    expect(shouldShowScrollToBottom({
      scrollHeight: 2400,
      scrollTop: 1600,
      clientHeight: 800,
    })).toBe(false);
  });

  it('appears whenever the viewport is meaningfully detached from the bottom', () => {
    expect(shouldShowScrollToBottom({
      scrollHeight: 2400,
      scrollTop: 1200,
      clientHeight: 800,
    })).toBe(true);
  });

  it('ignores small layout shifts near the bottom', () => {
    expect(shouldShowScrollToBottom({
      scrollHeight: 2400,
      scrollTop: 1510,
      clientHeight: 800,
    })).toBe(false);
  });
});
