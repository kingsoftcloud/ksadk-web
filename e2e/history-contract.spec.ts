import { expect, test, type Page } from '@playwright/test';

type Json = Record<string, unknown>;
const message = (id: string, text: string, seq: number) => ({
  MessageId: id, Role: 'assistant', Content: { text }, SeqId: seq,
});
const first = (session = 's') => ({
  Messages: [message(`${session}-old`, session === 's' ? 'Old history' : 'Other session', 9)],
  LatestSeqId: 12, HasMore: session === 's', NextCursor: session === 's' ? 8 : null,
  DataSource: 'control_fallback', Degraded: true, CursorSource: 'control',
  CursorCompatibleWithRuntime: false, SessionContractVersion: 2,
  HistoryEpoch: 'epoch-1', PersistenceDegraded: session === 's', SnapshotSeqId: 0,
});
const ok = (data: unknown) => ({ Code: 0, Message: 'Success', Data: data });
const reload = { Code: 409, Message: 'History source changed', Data: null,
  ReasonCode: 'HISTORY_RELOAD_REQUIRED' };

async function intercept(page: Page,
  messages: (body: Json, index: number) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown },
  events?: (body: Json, index: number) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown }) {
  const calls: Array<{ action: string; body: Json }> = [];
  let messageCount = 0;
  let eventCount = 0;
  await page.route('**/agentengine/api/v1/*', async route => {
    const action = route.request().url().split('/').pop() || '';
    const body = route.request().postDataJSON() as Json;
    calls.push({ action, body });
    let response: { status?: number; body: unknown };
    if (action === 'ListSessionMessages') response = await messages(body, ++messageCount);
    else if (action === 'ListSessionEvents') response = events
      ? await events(body, ++eventCount)
      : { body: ok({ Events: [], Total: 2, CursorSource: 'runtime',
        HistoryEpoch: 'runtime-epoch', SnapshotSeqId: 0 }) };
    else response = { body: ok({}) };
    await route.fulfill({ status: response.status ?? 200, contentType: 'application/json',
      body: JSON.stringify(response.body) });
  });
  await page.goto('/e2e/fixtures/history-contract.html');
  return calls;
}

test('short-page history has an explicit bounded loader without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1500 });
  const calls = await intercept(page, (_body, index) => ({ body: ok(index === 1 ? first() : {
    ...first(), Messages: [message(`older-${index}`, `Earlier page ${index}`, index === 2 ? 5 : 1)],
    HasMore: index === 2, NextCursor: index === 2 ? 4 : null,
  }) }));
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(1);
  await page.getByTestId('history-load-older').click();
  await expect(page.getByText('Earlier page 2')).toBeVisible();
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
  expect(calls.filter(call => call.action === 'ListSessionMessages')[1].body).toMatchObject({
    BeforeSeqId: 8, HistoryEpoch: 'epoch-1', SnapshotSeqId: 0, CursorSource: 'control',
  });
  await page.getByTestId('history-load-older').click();
  await expect(page.getByText('Earlier page 3')).toBeVisible();
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(3);
  await expect(page.getByTestId('history-load-older')).toHaveCount(0);
});

test('explicit older pages keep the reading position in an overflowing transcript', async ({ page }) => {
  const recent = Array.from({ length: 28 }, (_, index) =>
    message(`recent-${index}`, `Recent reply ${index}\n\n` + '- detail line\n'.repeat(index % 6 + 2), index + 28));
  const older = Array.from({ length: 20 }, (_, index) =>
    message(`older-${index}`, `Earlier reply ${index}\n\n` + '- detail line\n'.repeat(index % 5 + 2), index + 1));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok({ ...first(), Messages: recent, LatestSeqId: 55, NextCursor: 28 }) };
    await held;
    return { body: ok({ ...first(), Messages: older, HasMore: true, NextCursor: 1, LatestSeqId: 55 }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  const latest = page.getByText('Recent reply 27', { exact: true });
  await expect(latest).toBeInViewport();
  const offset = () => latest.evaluate(element =>
    element.getBoundingClientRect().top - element.closest('[data-slot="message-list"]')!.getBoundingClientRect().top);
  const before = await offset();
  await page.getByTestId('history-load-older').click();
  await expect(page.getByTestId('history-load-older')).toBeDisabled();
  await expect(latest).toBeInViewport();
  release();
  await expect(page.getByTestId('history-load-older')).toBeEnabled();
  await expect(latest).toBeInViewport();
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThanOrEqual(2);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
});

test('scroll-triggered older pages keep the visible message at the same offset', async ({ page }) => {
  const recent = Array.from({ length: 25 }, (_, index) =>
    message(`recent-${index}`, `Recent model text ${index}\n\n` + '- details\n'.repeat(index % 4 + 3), index + 21));
  const older = Array.from({ length: 20 }, (_, index) =>
    message(`older-${index}`, `Earlier model text ${index}\n\n` + '- details\n'.repeat(index % 5 + 2), index + 1));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok({ ...first(), Messages: recent, LatestSeqId: 45, NextCursor: 21 }) };
    await held;
    return { body: ok({ ...first(), Messages: older, HasMore: false, NextCursor: null, LatestSeqId: 45 }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Recent model text 24', { exact: true })).toBeInViewport();
  const scroller = page.locator('[data-slot="message-list"]');
  await expect.poll(() => scroller.evaluate(element => (element as HTMLElement).style.scrollBehavior)).toBe('');
  await scroller.evaluate(element => { element.scrollTop = 100; });
  await expect(page.getByTestId('history-load-older')).toBeDisabled();
  const anchor = page.getByText('Recent model text 1', { exact: true });
  await expect(anchor).toBeInViewport();
  const relativeOffset = () => anchor.evaluate(element => {
    const viewport = element.closest('[data-slot="message-list"]')!;
    return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
  const before = await relativeOffset();
  release();
  await expect(page.getByTestId('history-load-older')).toHaveCount(0);
  await expect(anchor).toBeInViewport();
  await expect.poll(async () => Math.abs(await relativeOffset() - before)).toBeLessThanOrEqual(2);
});

test('one prefetched cursor is consumed by an upward gesture at the top of a short viewport', async ({ page }) => {
  const itemPage = (seq: number, text: string, cursor: string | null) => ({
    HistoryView: 'items-v1', CursorSource: 'runtime', HistoryEpoch: 'pinned', SnapshotSeqId: 2,
    HasMore: Boolean(cursor), NextItemCursor: cursor, NextCursor: null, LatestSeqId: 2, Messages: [],
    Items: [{ ItemId: `item-${seq}`, SeqId: seq, EventType: 'user_message',
      Event: { SessionId: 's', EventId: `event-${seq}`, SeqId: seq, EventType: 'user_message',
        Content: { parts: [{ text }] } } }],
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(itemPage(2, 'Recent short turn', 'before-2')) };
    await held;
    return { body: ok(itemPage(1, 'Older short turn', null)) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  const recent = page.getByText('Recent short turn');
  const older = page.getByTestId('history-load-older');
  await expect(recent).toBeInViewport();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(2);
  await expect(older).toBeEnabled();
  await page.locator('[data-slot="message-list"]').hover();
  await page.mouse.wheel(0, -120);
  await expect(older).toBeDisabled();
  release();
  await expect(page.getByText('Older short turn')).toBeInViewport();
  await expect(older).toHaveCount(0);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
});

test('a pinned Messages page is prefetched and upward input loads it at the scroll edge', async ({ page }) => {
  const pinned = { ...first(), CursorSource: 'runtime', HistoryEpoch: 'pinned-messages',
    SnapshotSeqId: 9, DataSource: 'runtime', Degraded: false, PersistenceDegraded: false,
    CursorCompatibleWithRuntime: true };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(pinned) };
    await held;
    return { body: ok({ ...pinned, Messages: [message('earlier', 'Earlier pinned message', 1)],
      HasMore: false, NextCursor: null }) };
  }, () => ({ body: ok({ Events: [], Total: 0, CursorSource: pinned.CursorSource,
    HistoryEpoch: pinned.HistoryEpoch, SnapshotSeqId: pinned.SnapshotSeqId }) }));
  await page.getByRole('button', { name: 'Open S' }).click();
  const loader = page.getByTestId('history-load-older');
  await expect(page.getByText('Old history')).toBeInViewport();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(2);
  await expect(loader).toBeEnabled();
  const list = page.locator('[data-slot="message-list"]');
  expect(await list.evaluate(el => el.scrollTop)).toBe(0);
  await list.hover();
  await page.mouse.wheel(0, -120);
  await expect(loader).toBeDisabled();
  release();
  await expect(page.getByText('Earlier pinned message')).toBeVisible();
  await expect(loader).toHaveCount(0);
  const reads = calls.filter(call => call.action === 'ListSessionMessages');
  expect(reads).toHaveLength(2);
  expect(reads[1].body).toMatchObject({ BeforeSeqId: 8, SnapshotSeqId: 9, HistoryEpoch: 'pinned-messages' });
});

test('showing or hiding the bottom button leaves the scroll range unchanged', async ({ page }) => {
  const tall = Array.from({ length: 120 }, (_, index) => `Reading line ${index}`).join('\n');
  await intercept(page, () => ({ body: ok({ ...first(), HasMore: false, NextCursor: null,
    Messages: [message('tall', tall, 9)] }) }));
  await page.getByRole('button', { name: 'Open S' }).click();
  const scroller = page.locator('[data-slot="message-list"]');
  await expect(scroller.getByText('Reading line 119', { exact: false })).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => (el as HTMLElement).style.scrollBehavior)).toBe('');
  const bottom = page.getByRole('button', { name: '回到底部' });
  await expect(bottom).toHaveCount(0);
  const height = () => scroller.evaluate(el => el.scrollHeight);
  const range = await height();
  await scroller.evaluate(el => { el.scrollTop -= 220; });
  await expect(bottom).toBeInViewport();
  expect(await height()).toBe(range);
  await bottom.click();
  await expect(bottom).toHaveCount(0);
  expect(await height()).toBe(range);
});

test('keeps the visible line when a long reply gains earlier text within its paragraph', async ({ page }) => {
  const marker = 'The exact reading line stays in place';
  const lines = (label: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${label} line ${index} has distinct diagnostic text.`).join('\n');
  const visible = lines('Retained intro', 70) + '\n**' + marker + '**\n' + lines('Retained tail', 55);
  const prefix = lines('Earlier paragraph', 15) + '\n\n' + lines('Earlier within the same paragraph', 40) + '\n';
  const itemPage = (seq: number, text: string, cursor: string | null) => ({
    HistoryView: 'items-v1', CursorSource: 'runtime', HistoryEpoch: 'partial-reply', SnapshotSeqId: 2,
    HasMore: Boolean(cursor), NextItemCursor: cursor, NextCursor: null, LatestSeqId: 2, Messages: [],
    Items: [{ ItemId: `item-${seq}`, SeqId: seq, EventType: 'assistant_stream_delta', InvocationId: 'same-run',
      Event: { SessionId: 's', EventId: `event-${seq}`, SeqId: seq,
        EventType: 'assistant_stream_delta', InvocationId: 'same-run', Content: { parts: [{ text }] } } }],
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(itemPage(2, visible, 'before-2')) };
    await held;
    return { body: ok(itemPage(1, prefix, null)) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  const list = page.locator('[data-slot="message-list"]');
  const line = list.getByText(marker, { exact: true });
  await expect(line).toBeVisible();
  await expect.poll(() => list.evaluate(el => (el as HTMLElement).style.scrollBehavior)).toBe('');
  await line.evaluate(el => {
    const scroll = el.closest<HTMLElement>('[data-slot="message-list"]')!;
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
  });
  const offset = () => line.evaluate(el => el.getBoundingClientRect().top
    - el.closest('[data-slot="message-list"]')!.getBoundingClientRect().top);
  const before = await offset();
  const older = page.getByTestId('history-load-older');
  await older.click();
  await expect(older).toBeDisabled();
  release();
  await expect(older).toHaveCount(0);
  await expect(list.getByText('Earlier paragraph line 0 has distinct diagnostic text.', { exact: false })).toBeVisible();
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThanOrEqual(2);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
});

test('keeps the reader anchored when older detail inserts rows after the first loaded message', async ({ page }) => {
  const marker = 'Read this line beside the restored detail';
  const line = (i: number) => `Tall reply line ${i} supports stable reading.`;
  const text = Array.from({ length: 75 }, (_, i) => i === 45 ? '**' + marker + '**' : line(i)).join('\n');
  const calls = await intercept(page, (_body, index) => ({
    body: ok(index === 1 ? { ...first(), Messages: [message('retained-first', 'Retained first row', 1),
      message('reading', text, 9)] } : { ...first(),
      Messages: [message('restored', 'Restored detail\n'.repeat(9), 4)], HasMore: false, NextCursor: null }),
  }));
  await page.getByRole('button', { name: 'Open S' }).click();
  const target = page.getByText(marker, { exact: true });
  const list = page.locator('[data-slot="message-list"]');
  await expect(target).toBeVisible();
  await expect.poll(() => list.evaluate(el => (el as HTMLElement).style.scrollBehavior)).toBe('');
  await target.evaluate(el => {
    const scroll = el.closest<HTMLElement>('[data-slot="message-list"]')!;
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
  });
  const offset = () => target.evaluate(el => el.getBoundingClientRect().top
    - el.closest('[data-slot="message-list"]')!.getBoundingClientRect().top);
  const before = await offset();
  const loader = page.getByTestId('history-load-older');
  await loader.click();
  await expect(loader).toHaveCount(0);
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThanOrEqual(2);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
});

test('remeasuring a clipped row keeps the visible content below it in place', async ({ page }) => {
  const marker = 'Visible text below the clipped message';
  const clipped = Array.from({ length: 85 }, (_, i) => `Earlier model text line ${i}`).join('\n');
  const tail = Array.from({ length: 85 }, (_, i) => `Visible model reply line ${i}`).join('\n');
  await intercept(page, () => ({ body: ok({ ...first(), HasMore: false, NextCursor: null,
    Messages: [message('clipped', clipped, 4), message('reading', marker + '\n' + tail, 9)] }) }));
  await page.getByRole('button', { name: 'Open S' }).click();
  const target = page.locator('[data-message-id="reading"]');
  const list = page.locator('[data-slot="message-list"]');
  await expect(target).toBeVisible();
  await expect.poll(() => list.evaluate(el => (el as HTMLElement).style.scrollBehavior)).toBe('');
  await list.evaluate(el => {
    const row = el.querySelector('[data-message-id="reading"]')!;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 100;
  });
  await expect(target).toBeInViewport();
  const offset = () => target.evaluate(el => el.getBoundingClientRect().top
    - el.closest('[data-slot="message-list"]')!.getBoundingClientRect().top);
  const before = await offset();
  const beforeScroll = await list.evaluate(el => el.scrollTop);
  await list.locator('[data-message-id="clipped"]').evaluate(row => {
    const height = row.getBoundingClientRect().height;
    const firstText = row.querySelector('p')?.firstChild;
    if (!firstText) throw new Error('Clipped text node not found');
    // Reproduce the browser choosing a caret above the visible reading line.
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true, value: () => ({ offsetNode: firstText, offset: 0 }),
    });
    (row as HTMLElement).style.height = `${height + 183}px`;
  });
  await expect.poll(() => list.evaluate((el, before) => el.scrollTop - before, beforeScroll)).toBe(183);
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThanOrEqual(2);
});

test('short-page loader disables repeats and ignores a response after switching sessions', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (body, index) => {
    if (body.SessionId === 't') return { body: ok(first('t')) };
    if (index === 1) return { body: ok(first()) };
    await held;
    return { body: ok({ ...first(), Messages: [message('late', 'Late short page', 1)],
      HasMore: false, NextCursor: null }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await page.getByTestId('history-load-older').click();
  await expect(page.getByTestId('history-load-older')).toBeDisabled();
  await page.getByTestId('history-load-older').evaluate((button: HTMLButtonElement) => button.click());
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
  await page.getByRole('button', { name: 'Open T' }).click();
  await expect(page.getByText('Other session')).toBeVisible();
  release();
  await expect(page.getByText('Late short page')).toHaveCount(0);
  await expect(page.getByTestId('history-load-older')).toHaveCount(0);
});

test('short-page loader preserves messages on failure and retries the same cursor', async ({ page }) => {
  const calls = await intercept(page, (_body, index) => index === 2
    ? { status: 400, body: { Code: 400, Message: 'Older page unavailable', Data: null } }
    : { body: ok(index === 1 ? first() : { ...first(),
        Messages: [message('recovered', 'Recovered earlier page', 1)], HasMore: false, NextCursor: null }) });
  await page.getByRole('button', { name: 'Open S' }).click();
  await page.getByTestId('history-load-older').click();
  await expect(page.getByTestId('history-reload-error')).toBeVisible();
  await expect(page.getByText('Old history')).toBeVisible();
  await expect(page.getByTestId('history-load-older')).toBeEnabled();
  await page.getByTestId('history-load-older').click();
  await expect(page.getByText('Recovered earlier page')).toBeVisible();
  const continuations = calls.filter(call => call.action === 'ListSessionMessages').slice(1);
  expect(continuations).toHaveLength(2);
  expect(continuations.every(call => call.body.BeforeSeqId === 8 && call.body.SnapshotSeqId === 0)).toBe(true);
});

test('browser shows persistence warning and sends source, epoch and zero snapshot on an empty visible page', async ({ page }) => {
  const calls = await intercept(page, async (_body, index) => ({ body: ok(index === 1 ? first() : {
    Messages: [], LatestSeqId: 12, HasMore: true, NextCursor: 4,
    CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0,
  }) }));
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await expect(page.getByTestId('history-persistence-warning')).toContainText('持久恢复尚未确认');
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(2);
  expect(calls.filter(call => call.action === 'ListSessionMessages')[1].body).toMatchObject({
    BeforeSeqId: 8, CursorSource: 'control', HistoryEpoch: 'epoch-1', SnapshotSeqId: 0,
  });
  expect(calls.filter(call => call.action === 'ListSessionEvents')).toHaveLength(1);
  await expect(page.getByText('Old history')).toBeVisible();
});

test('browser keeps the old transcript visible until one 409 reload succeeds', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(first()) };
    if (index === 2) return { body: reload };
    await held;
    return { body: ok({ ...first(), Messages: [message('replacement', 'New history', 2)],
      HasMore: false, NextCursor: null, CursorSource: 'runtime', HistoryEpoch: 'epoch-2',
      PersistenceDegraded: false, SnapshotSeqId: 2 }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(3);
  await expect(page.getByText('Old history')).toBeVisible();
  expect(calls.filter(call => call.action === 'ListSessionMessages')[2].body).not.toHaveProperty('BeforeSeqId');
  release();
  await expect(page.getByText('New history')).toBeVisible();
  await expect(page.getByText('Old history')).toHaveCount(0);
  await expect(page.getByTestId('history-persistence-warning')).toHaveCount(0);
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(3);
});

test('browser retains old content, clears pagination and stops after failed reload', async ({ page }) => {
  const calls = await intercept(page, async (_body, index) => index === 1
    ? { body: ok(first()) } : { status: index === 3 ? 409 : 200, body: reload });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  await expect(page.getByTestId('history-reload-error')).toContainText('原有消息已保留');
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(3);
});

test('browser discards an older response after switching sessions', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (body, index) => {
    if (body.SessionId === 't') return { body: ok(first('t')) };
    if (index === 1) return { body: ok(first()) };
    await held;
    return { body: ok({ ...first(), Messages: [message('stale', 'Stale old page', 3)],
      HasMore: false, NextCursor: null }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(2);
  await page.getByRole('button', { name: 'Open T' }).click();
  await expect(page.getByText('Other session')).toBeVisible();
  release();
  await expect(page.getByText('Stale old page')).toHaveCount(0);
});

test('browser reloads once when event history reports an expired epoch', async ({ page }) => {
  const calls = await intercept(page, async (_body, index) => ({ body: ok(index === 1 ? first() : {
    ...first(), Messages: [message('fresh', 'Fresh after event expiry', 3)],
    HistoryEpoch: 'epoch-2', HasMore: false, NextCursor: null,
  }) }), async (_body, index) => index === 1
    ? { body: reload }
    : { body: ok({ Events: [], Total: 0, CursorSource: 'control',
      HistoryEpoch: 'epoch-2', SnapshotSeqId: 0 }) });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Fresh after event expiry')).toBeVisible();
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
  expect(calls.filter(call => call.action === 'ListSessionEvents')).toHaveLength(2);
});

test('browser ignores an event page that arrives after switching sessions', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, body => ({ body: ok(first(String(body.SessionId))) }),
    async (body) => {
      if (body.SessionId === 's') await held;
      return { body: ok({ Events: [], Total: 0, CursorSource: 'control',
        HistoryEpoch: 'epoch-1', SnapshotSeqId: 0 }) };
    });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionEvents').length).toBe(1);
  await page.getByRole('button', { name: 'Open T' }).click();
  await expect(page.getByText('Other session')).toBeVisible();
  release();
  await expect(page.getByText('Other session')).toBeVisible();
  await expect(page.getByText('Old history')).toHaveCount(0);
});

test('browser cancellation prevents a late 409 reload from replacing visible history', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(first()) };
    if (index === 2) return { body: reload };
    await held;
    return { body: ok({ ...first(), Messages: [message('late', 'Late replacement', 2)],
      HasMore: false, NextCursor: null, HistoryEpoch: 'epoch-2' }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S cancellable' }).click();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(3);
  await page.getByRole('button', { name: 'Cancel older' }).click();
  release();
  await expect(page.getByText('Old history')).toBeVisible();
  await expect(page.getByText('Late replacement')).toHaveCount(0);
});

test('browser retains a live turn received while the 409 replacement page is pending', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls = await intercept(page, async (_body, index) => {
    if (index === 1) return { body: ok(first()) };
    if (index === 2) return { body: reload };
    await held;
    return { body: ok({ ...first(), Messages: [message('fresh', 'Fresh history', 2)],
      HasMore: false, NextCursor: null, CursorSource: 'runtime', HistoryEpoch: 'epoch-2' }) };
  });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.action === 'ListSessionMessages').length).toBe(3);
  await page.getByRole('button', { name: 'Append live turn' }).click();
  await expect(page.getByText('New live question')).toBeVisible();
  await expect(page.getByText('New live answer')).toBeVisible();
  release();
  await expect(page.getByText('Fresh history')).toBeVisible();
  await expect(page.getByText('Old history')).toHaveCount(0);
  await expect(page.getByText('New live question')).toBeVisible();
  await expect(page.getByText('New live answer')).toBeVisible();
});

test('browser preparation polling keeps one pagination request and cancellation clears the indicator', async ({ page }) => {
  const calls = await intercept(page, (_body, index) => index === 1
    ? { body: ok(first()) }
    : { body: { Code: 503, Message: 'Preparing', ReasonCode: 'HISTORY_PREPARING', Data: null } });
  await page.getByRole('button', { name: 'Open S' }).click();
  await expect(page.getByText('Old history')).toBeVisible();
  await page.getByRole('button', { name: 'Older S cancellable' }).click();
  await expect(page.getByTestId('history-preparing')).toBeVisible();
  await page.getByRole('button', { name: 'Older S', exact: true }).click();
  expect(calls.filter(call => call.action === 'ListSessionMessages')).toHaveLength(2);
  await page.getByRole('button', { name: 'Cancel older' }).click();
  await expect(page.getByTestId('history-preparing')).toHaveCount(0);
  await expect(page.getByText('Old history')).toBeVisible();
});
