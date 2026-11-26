import { expect, test } from '@playwright/test';

test('one historical invocation remains traversable through the real Runtime', async ({ page }) => {
  const seen = new Set<number>();
  let cursor: string | null = null;
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  for (let count = 0; count < 17328; count++) {
    const received = page.waitForResponse(r => r.url().endsWith('/ListSessionMessages'));
    const button = page.getByRole('button', { name: count ? 'Older A' : 'Open A', exact: true });
    await button.evaluate(element => (element as HTMLButtonElement).click());
    const response = await received;
    if (count) expect(response.request().postDataJSON().ItemCursor).toBe(cursor);
    const { Code, Data } = await response.json();
    expect(Code).toBe(0);
    expect(Data.HistoryView).toBe('items-v1');
    expect(Data.SnapshotSeqId).toBe(17328);
    expect(Data.Items.length).toBeGreaterThan(0);
    for (const item of Data.Items) {
      if (seen.has(item.SeqId)) throw new Error(`Duplicate item ${item.SeqId}`);
      seen.add(item.SeqId);
    }
    cursor = Data.NextItemCursor;
    await page.waitForFunction(next => {
      const state = (window as any).localHistoryProbe().history['local-heavy-A'];
      return state && !state.isLoadingOlder && state.nextItemCursor === next;
    }, cursor);
    if (!Data.HasMore) break;
  }
  expect([...seen].sort((a,b) => a-b)).toEqual(Array.from({length: 17328}, (_,i) => i+1));
  const messages = await page.evaluate(() => (window as any).localHistoryProbe().messages
    .map((message: {content: unknown}) => message.content));
  expect(messages).toContain('browser-marker-1');
  expect(messages).toContain('browser-marker-17328');
  // Every intermediate progress update remains inspectable even though the UI
  // groups thousands of them into one expandable row.
  await page.getByRole('button', { name: /展开.*历史事件/ }).click();
  const details = await page.locator('pre').filter({ hasText: 'browser-marker-2' }).innerText();
  const displayed = [...details.matchAll(/browser-marker-(\d+)/g)].map(match => Number(match[1]));
  expect(displayed).toEqual(Array.from({ length: 17325 }, (_, index) => index + 2));
});

test('large text stays deferred until expanded and includes its final characters', async ({ page }) => {
  const offsets: number[] = [];
  page.on('request', req => {
    if (req.url().endsWith('/ListSessionMessages') && req.postDataJSON()?.ContentSeqId) {
      offsets.push(req.postDataJSON().ContentOffset);
    }
  });
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  await page.getByRole('button', { name: 'Open A', exact: true }).click();
  const expand = page.getByRole('button', { name: /展开.*assistant_message/ });
  await expect(expand).toBeVisible();
  expect(offsets).toEqual([]);
  await expand.click();
  await expect(page.locator('pre').filter({ hasText: 'BODY_END' })).toHaveText('全文'.repeat(100000) + 'BODY_END');
  expect(offsets.length).toBeGreaterThan(1);
  expect(offsets[0]).toBe(0);
  expect(offsets).toEqual([...new Set(offsets)].sort((a, b) => a - b));
});
