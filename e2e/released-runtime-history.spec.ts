import { expect, test } from '@playwright/test';

// Seed the disposable Runtime database with e2e/fixtures/seed-released-runtime-history.py.
test.skip(!process.env.KSADK_RELEASED_RUNTIME_FACADE && !process.env.KSADK_HISTORY_FACADES,
  'Set KSADK_RELEASED_RUNTIME_FACADE for one release or KSADK_HISTORY_FACADES for a release matrix.');

test.beforeEach(async ({ page }, testInfo) => {
  const target = testInfo.project.metadata.facade ?? process.env.KSADK_RELEASED_RUNTIME_FACADE;
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

test('displays a rich giant invocation in sequence order with distinct same-name tools across pages', async ({ page }, testInfo) => {
  test.setTimeout(15 * 60_000);
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  const pages: number[] = [];
  let boundary = 17329;
  let cursor: string | null = null;
  let fail = false;
  const requests: string[] = [];
  await page.route('**/ListSessionMessages', async route => {
    requests.push(route.request().postDataJSON().ItemCursor || '');
    if (!fail) return route.fallback();
    fail = false;
    await route.fulfill({ json: { Code: 504, Message: 'History timeout', Data: null } });
  });
  const nextResponse = () => page.waitForResponse(r => r.url().endsWith('/ListSessionMessages'));
  const apply = async (received: Awaited<ReturnType<typeof nextResponse>>) => {
    const { Code, Data } = await received.json();
    expect(Code).toBe(0);
    expect(Data.HistoryView).toBe('items-v1');
    expect(Data.Items.length).toBeGreaterThan(0);
    expect(received.request().postDataJSON().ItemCursor ?? null).toBe(cursor);
    for (const item of [...Data.Items].reverse()) expect(item.SeqId).toBe(--boundary);
    cursor = Data.NextItemCursor;
    await page.waitForFunction(next => {
      const state = (window as any).localHistoryProbe().history['local-heavy-C'];
      return state && !state.isLoadingOlder && state.nextItemCursor === next;
    }, cursor);
  };
  const started = Date.now();
  const first = nextResponse();
  await page.getByRole('button', { name: 'Open C', exact: true }).click();
  await apply(await first);
  await expect(page.getByText('rich-model-final', { exact: true })).toBeVisible();
  const firstPaintMs = Date.now() - started;
  const readModel = () => page.evaluate(() => (window as any).localHistoryProbe().messages.map((m: any) => ({
    role: m.role, text: m.content, reasoning: m.reasoning, seq: m.historyOrder?.seq,
    tools: Object.values(m.tools || {}).map((tool: any) => ({ id: tool.callId, name: tool.name,
      args: tool.args, output: tool.output, status: tool.status })),
  })));
  const late = await readModel();
  expect(late.flatMap((row: any) => row.tools).map((tool: any) => tool.id)).toEqual(['lookup-B', 'lookup-A']);
  fail = true;
  await page.getByTestId('history-load-older').click();
  const retry = page.getByTestId('history-reload-error').getByRole('button', { name: '重试' });
  await expect(retry).toBeVisible();
  expect(await readModel()).toEqual(late);
  let firstOlder = true;
  let checkedPartialCalls = false;
  while (cursor) {
    const then = Date.now();
    const response = nextResponse();
    const button = firstOlder ? retry : page.getByRole('button', { name: 'Older C', exact: true });
    await button.evaluate(el => (el as HTMLButtonElement).click());
    await apply(await response);
    pages.push(Date.now() - then);
    if (boundary <= 17232 && boundary > 17199) {
      const partial = (await readModel()).flatMap((row: any) => row.tools);
      expect(partial).toHaveLength(2);
      expect(partial.find((tool: any) => tool.id === 'lookup-B')).toMatchObject({
        args: expect.stringContaining('rich-argument-B'), output: expect.stringContaining('rich-result-B'), status: 'error',
      });
      expect(partial.find((tool: any) => tool.id === 'lookup-A')).toMatchObject({
        args: '', output: expect.stringContaining('rich-result-A'), status: 'completed',
      });
      checkedPartialCalls = true;
    }
    firstOlder = false;
  }
  expect(requests[1]).toBe(requests[2]);
  expect(boundary).toBe(1);
  expect(checkedPartialCalls).toBe(true);
  const rows = await readModel();
  const text = rows.filter((row: any) => row.role === 'user' || row.role === 'model')
    .map((row: any) => row.text).filter(Boolean);
  expect(text).toEqual(['rich-user-opening', 'rich-model-opening', 'rich-model-before-tools',
    'rich-model-during-tools', 'rich-model-after-tools', 'rich-model-final']);
  expect(rows.map((row: any) => row.reasoning).filter(Boolean)).toEqual(['rich-reasoning-opening', 'rich-reasoning-ending']);
  expect(rows.flatMap((row: any) => row.tools.map((tool: any) => ({
    seq: row.seq, id: tool.id, name: tool.name, args: JSON.parse(tool.args),
    output: JSON.parse(tool.output), status: tool.status,
  })))).toEqual([
    { seq: 17199, id: 'lookup-A', name: 'example_lookup', args: {term: 'rich-argument-A'},
      output: { value: 'rich-result-A' }, status: 'completed' },
    { seq: 17232, id: 'lookup-B', name: 'example_lookup', args: {term: 'rich-argument-B'},
      output: { value: 'rich-result-B' }, status: 'error' },
  ]);
  // Inspect the actual expandable cards. A retained fact in the store alone
  // cannot prove that both same-name calls and their outcomes are readable.
  const visibleTool = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'example_lookup' }) });
  await expect(visibleTool).toHaveCount(2);
  for (const [i, letter] of ['A', 'B'].entries()) {
    const details = visibleTool.nth(i);
    await details.locator('summary').click();
    await expect(details).toContainText('rich-argument-' + letter);
    await expect(details).toContainText('rich-result-' + letter);
    if (letter === 'B') await expect(details.locator('summary')).toContainText('失败');
  }
  for (const summary of await page.locator('summary').filter({ hasText: '思考过程' }).all()) await summary.click();
  for (const expected of ['rich-reasoning-opening', 'rich-reasoning-ending', ...text]) {
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
  }
  const chronological = await page.locator('main').innerText();
  const markers = ['rich-user-opening', 'rich-reasoning-opening', 'rich-model-opening', 'rich-model-before-tools',
    'rich-argument-A', 'rich-argument-B', 'rich-model-during-tools', 'rich-reasoning-ending',
    'rich-model-after-tools', 'rich-model-final'];
  const positions = markers.map(marker => chronological.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a,b) => a-b));
  const sorted = [...pages].sort((a,b) => a-b);
  const metrics = { project: testInfo.project.name, test: testInfo.title, firstPaintMs, olderPages: pages.length, p50OlderMs: sorted[Math.floor(pages.length * .5)],
    p95OlderMs: sorted[Math.floor(pages.length * .95)], maxOlderMs: sorted.at(-1) };
  console.log('rich-history-browser', JSON.stringify(metrics));
  await testInfo.attach('history-timings', { body: JSON.stringify(metrics), contentType: 'application/json' });
  if (process.env.KSADK_HISTORY_FIRST_PAINT_MS) {
    expect(firstPaintMs).toBeLessThanOrEqual(Number(process.env.KSADK_HISTORY_FIRST_PAINT_MS));
  }
  if (process.env.KSADK_HISTORY_OLDER_P95_MS) {
    expect(metrics.p95OlderMs).toBeLessThanOrEqual(Number(process.env.KSADK_HISTORY_OLDER_P95_MS));
  }
});
