import { describe, expect, it } from 'vitest';
import { coalesceA2uiActivities } from '../core/a2ui/transcript.js';
import { mergeHistoryWithLive } from '../utils/transcript-order.js';
import type { Message } from '../components/chat/types.js';

const birth = [{ version: 'v0.9.1', createSurface: { surfaceId: 'one', catalogId: 'official' } }];
const update = [{ version: 'v0.9.1', updateDataModel: { surfaceId: 'one', path: '/', value: { answer: false } } }];
const message = (id: string, extra: Partial<Message>): Message => ({
  id, role: 'model', content: '', timestamp: 1, runId: 'same-logical-run', ...extra,
});

describe('one A2UI surface across live and historical carriers', () => {
  it('keeps business text and merges a history copy into the first live activity', () => {
    const live = message('live', { content: 'Business JSON is still visible', aguiActivities: [{ surfaceId: 'one', messages: birth }] });
    const history = message('history', { role: 'a2ui', aguiActivity: { surfaceId: 'one', messages: birth.concat(update), interactionId: 'original-wait' } });
    const snapshot = structuredClone(live);
    const result = coalesceA2uiActivities([live, history]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(live.content);
    expect(result[0].aguiActivities?.[0]).toMatchObject({ messages: birth.concat(update), interactionId: 'original-wait' });
    expect(live).toEqual(snapshot);
    expect(coalesceA2uiActivities(result)).toBe(result);
  });

  it('joins partial updates without losing another surface or ordinary messages', () => {
    const base = message('a', { aguiActivity: { surfaceId: 'one', messages: birth } });
    const next = message('b', { role: 'a2ui', aguiActivity: { surfaceId: 'one', messages: update } });
    const other = message('c', { role: 'a2ui', aguiActivity: { surfaceId: 'two', messages: birth } });
    const text = message('answer', { content: '0' });
    const result = coalesceA2uiActivities([base, other, next, text]);
    expect(result.map(row => row.id)).toEqual(['a', 'c', 'answer']);
    expect(result[0].aguiActivity?.messages).toEqual([...birth, ...update]);
  });

  it('keeps the newer full history during a feedback-only live update', () => {
    const original = message('a', { content: 'Answer', aguiActivity: { surfaceId: 'one', messages: birth } });
    const latest = { ...original, aguiActivity: { surfaceId: 'one', messages: [...birth, ...update] } };
    const result = mergeHistoryWithLive([latest], [original], [{ ...original, feedback: { rating: 'up' } as Message['feedback'] }]);
    expect(result[0].aguiActivity?.messages).toEqual([...birth, ...update]);
  });
});
