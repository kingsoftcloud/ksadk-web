import { describe, expect, it } from 'vitest';

import { resolveCompactSessionMeta } from '../utils/session-list.js';

describe('hosted session list status projection', () => {
  it('keeps completed sessions silent and uses the updated time as ordinary metadata', () => {
    expect(resolveCompactSessionMeta({
      ActiveRunStatus: 'completed',
      UpdatedAt: '2026-05-07T08:45:00Z',
    })).toEqual({
      running: false,
      failed: false,
      label: '5月7日 16:45',
    });
  });

  it('projects active and failed statuses without exposing raw status text', () => {
    const now = Date.parse('2026-05-07T08:46:00Z');

    expect(resolveCompactSessionMeta({
      ActiveRunStatus: 'resuming',
      UpdatedAt: '2026-05-07T08:45:00Z',
    }, { now })).toEqual({
      running: true,
      failed: false,
      label: '',
    });
    expect(resolveCompactSessionMeta({
      ActiveRunStatus: 'resume_failed',
      UpdatedAt: '2026-05-07T08:45:00Z',
    })).toEqual({
      running: false,
      failed: true,
      label: '',
    });
  });
});
