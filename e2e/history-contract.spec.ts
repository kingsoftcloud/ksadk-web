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
