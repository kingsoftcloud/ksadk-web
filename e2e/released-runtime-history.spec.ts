import { expect, test } from '@playwright/test';

const target = process.env.KSADK_RELEASED_RUNTIME_FACADE;
test.skip(!target, 'Set KSADK_RELEASED_RUNTIME_FACADE to the fixture control-plane URL.');

test.beforeEach(async ({ page }) => {
  await page.route('**/agentengine/api/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const response = await route.fetch({ url: new URL(url.pathname + url.search, target).href,
      headers: { ...req.headers(), 'x-ksc-account-id': 'acct-1' } });
    await route.fulfill({ response });
  });
});

test('retains chat messages and their negotiated page cursor across an older-page timeout', async ({ page }) => {
  const cursors: unknown[] = [];
  let failNext = false;
  await page.route('**/ListSessionMessages', async route => {
    const req = route.request();
    cursors.push(req.postDataJSON().ItemCursor ?? req.postDataJSON().BeforeSeqId ?? null);
    if (failNext) {
      failNext = false;
      await route.fulfill({ json: { Code: 504, Message: 'History timeout', Data: null } });
      return;
    }
    await route.fallback();
  });
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  const nextPage = () => page.waitForResponse(r => r.url().endsWith('/ListSessionMessages'))
    .then(r => r.json()).then(r => r.Data);
  const countMarkers = (data: any) => data.HistoryView === 'items-v1'
    ? data.Items.filter((item: any) => ['user_message', 'assistant_message'].includes(item.EventType)).length
    : data.Messages.length;
  const cursor = (data: any) => data.NextItemCursor || data.NextCursor;
  const messages = () => page.evaluate(() => (window as any).localHistoryProbe().messages
    .filter((m: any) => m.role === 'model' || m.role === 'user').map((m: any) => m.content)
    .filter((text: string) => text.startsWith('ordinary-marker-')));
  const history = () => page.evaluate(() => (window as any).localHistoryProbe().history['local-heavy-B']);
  const firstRead = nextPage();
  await page.getByRole('button', { name: 'Open B', exact: true }).click();
  const first = await firstRead;
  await expect.poll(messages).toHaveLength(countMarkers(first));
  await expect.poll(async () => (await history()).isLoadingInitial).toBe(false);
  const before = await messages();
  expect(before.at(-1)).toBe('ordinary-marker-120');
  const tools = await page.evaluate(() => (window as any).localHistoryProbe().messages
    .flatMap((m: any) => Object.values(m.tools || {})));
  expect(tools).toContainEqual(expect.objectContaining({ name: 'example_lookup', status: 'completed' }));
  const older = page.getByTestId('history-load-older');
  failNext = true;
  await older.click();
  const retry = page.getByTestId('history-reload-error').getByRole('button', { name: '重试' });
  await expect(retry).toBeVisible();
  expect(await messages()).toEqual(before);
  const nextRead = nextPage();
  await retry.click();
  const next = await nextRead;
  await expect.poll(messages).toHaveLength(countMarkers(first) + countMarkers(next));
  await older.click();
  await expect.poll(messages).toHaveLength(120);
  expect(await messages()).toEqual(Array.from({ length: 120 }, (_, i) => 'ordinary-marker-' + (i + 1)));
  expect(cursors).toEqual([null, cursor(first), cursor(first), cursor(next)]);
});

test('opens the giant call and exhausts every compatible item page', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  let cursor: string | null = null;
  let total = 0;
  let boundary = 17329;
  for (;;) {
    const response = page.waitForResponse(r => r.url().endsWith('/ListSessionMessages'));
    await page.getByRole('button', { name: total ? 'Older A' : 'Open A', exact: true })
      .evaluate(element => (element as HTMLButtonElement).click());
    const received = await response;
    const { Code, Data } = await received.json();
    expect(Code).toBe(0);
    if (Data.HistoryView !== 'items-v1') {
      expect(Data.HasMore).toBe(false);
      expect(Data.Messages).toHaveLength(2);
      break;
    }
    expect(received.request().postDataJSON().ItemCursor ?? null).toBe(cursor);
    expect(Data.Items.length).toBeGreaterThan(0);
    for (const item of [...Data.Items].reverse()) expect(item.SeqId).toBe(--boundary);
    total += Data.Items.length;
    cursor = Data.NextItemCursor;
    await page.waitForFunction(next => {
      const state = (window as any).localHistoryProbe().history['local-heavy-A'];
      return state && !state.isLoadingOlder && state.nextItemCursor === next;
    }, cursor);
    if (!Data.HasMore) {
      expect(total).toBe(17328);
      break;
    }
  }
  await expect(page.getByText('browser-marker-1', { exact: true })).toBeVisible();
  await expect(page.getByText('browser-marker-17328', { exact: true })).toBeVisible();
  if (total) {
    await page.getByRole('button', { name: /展开.*历史事件/ }).click();
    const text = await page.locator('pre').filter({ hasText: 'browser-marker-2' }).innerText();
    expect([...text.matchAll(/browser-marker-(\d+)/g)].map(match => Number(match[1])))
      .toEqual(Array.from({ length: 17326 }, (_, index) => index + 2));
  }
});
