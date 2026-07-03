import { describe, expect, it } from 'vitest';
import { findActiveRunIds } from '../utils/run-state.js';
import { sessionTitle, sessionUpdatedAtValue } from '../utils/session-helpers.js';
import type { Session } from '../components/chat/types.js';

describe('session state helpers', () => {
  it('treats resume and starting run statuses as active subscriptions', () => {
    const now = Date.now();

    expect(findActiveRunIds([
      {
        InvocationId: 'resume-1',
        EventType: 'run_status',
        Content: { status: 'resuming' },
        Timestamp: now,
      },
      {
        InvocationId: 'run-2',
        EventType: 'run_status',
        Content: { status: 'starting' },
        Timestamp: now,
      },
    ], { now })).toEqual(['resume-1', 'run-2']);
  });

  it('uses last prompt and summary as title fallbacks', () => {
    expect(sessionTitle({
      SessionId: 's1',
      LastPrompt: '继续调研国产数据库',
    } as Session)).toBe('继续调研国产数据库');

    expect(sessionTitle({
      SessionId: 's2',
      Summary: '关于 K8s 成本优化的会话',
    } as Session)).toBe('关于 K8s 成本优化的会话');
  });

  it('normalizes numeric session timestamps to milliseconds', () => {
    expect(sessionUpdatedAtValue({ SessionId: 's1', UpdatedAt: 1782445527 } as Session)).toBe(1782445527000);
    expect(sessionUpdatedAtValue({ SessionId: 's2', UpdatedAt: 1782445527000 } as Session)).toBe(1782445527000);
  });
});
