import { expect, test } from '@playwright/test';

test('real Docker history renders, paginates and ignores an old session response', async ({ page }) => {
  // Only transport is proxied. Every response body/status comes from the real
  // Docker Runtime and PostgreSQL corpus; there are no canned API responses.
  const calls: Array<{ action: string; request: Record<string, any>; response: any }> = [];
  let closing = false;
  let holdOlder = false;
  let releaseOlder!: () => void;
  let olderArrived!: () => void;
  const held = new Promise<void>(resolve => { releaseOlder = resolve; });
  const arrived = new Promise<void>(resolve => { olderArrived = resolve; });
  await page.route('**/agentengine/api/v1/*', async route => {
    try {
      const action = route.request().url().split('/').pop()!;
      const request = route.request().postDataJSON();
      const response = await route.fetch({
        url: 'http://127.0.0.1:18087/agentengine/api/v1/' + action,
        timeout: 10_000,
      });
      const body = await response.json();
      calls.push({ action, request, response: body });
      if (holdOlder && action === 'ListSessionMessages' && request.SessionId === 'local-heavy-A' && request.BeforeSeqId) {
        olderArrived();
        await held;
      }
      await route.fulfill({ response });
    } catch (error) {
      if (!closing && !page.isClosed() && !route.request().failure()) throw error;
    }
  });
  await page.goto('/e2e/fixtures/local-heavy-history.html');
  await page.getByRole('button', { name: 'Open A', exact: true }).click();
  await expect(page.locator('main')).toContainText('REPORT_END LGHEAVY_new_A_R0024');
  await expect.poll(() => calls.some(c => c.action === 'ListSessionEvents' && c.request.SessionId === 'local-heavy-A')).toBe(true);
  await page.getByRole('button', { name: 'Older A', exact: true }).click();
  await expect.poll(() => calls.filter(c => c.action === 'ListSessionMessages').length).toBe(2);
  const pages = calls.filter(c => c.action === 'ListSessionMessages');
  expect(pages[1].request.BeforeSeqId).toBe(pages[0].response.Data.NextCursor);
  expect(pages[1].request.HistoryEpoch).toBe(pages[0].response.Data.HistoryEpoch);
  expect(pages[1].request.SnapshotSeqId).toBe(pages[0].response.Data.SnapshotSeqId);
  expect(pages[1].request.CursorSource).toBe('runtime');
  await expect.poll(() => page.evaluate(() => (window as any).localHistoryProbe().messages
    .some((m: any) => String(m.content).includes('REPORT_END LGHEAVY_new_A_R0023')))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).localHistoryProbe().history['local-heavy-A'].isLoadingOlder)).toBe(false);

  holdOlder = true;
  await page.getByRole('button', { name: 'Older A', exact: true }).click();
  await arrived;
  await page.getByRole('button', { name: 'Open B', exact: true }).click();
  await expect(page.locator('main')).toContainText('REPORT_END LGHEAVY_new_B_R0024');
  releaseOlder();
  await page.getByRole('button', { name: 'Open C', exact: true }).click();
  await expect(page.locator('main')).toContainText('REPORT_END LGHEAVY_new_C_R0024');
  await expect.poll(() => calls.some(c => c.action === 'ListSessionEvents' && c.request.SessionId === 'local-heavy-C')).toBe(true);
  // Tool details must retain the end marker past the former 8192-character cut.
  await page.getByRole('button', { name: '已完成 analyze_partition', exact: true }).first().click();
  await expect(page.locator('main')).toContainText('TOOL_END LGHEAVY_new_C_R0024');
  const current = await page.evaluate(() => (window as any).localHistoryProbe());
  expect(current.current).toBe('local-heavy-C');
  expect(current.messages.every((m: any) => !/LGHEAVY_new_[AB]_/.test(String(m.content)))).toBe(true);
  expect(new Set(current.messages.map((m: any) => m.id)).size).toBe(current.messages.length);
  for (const call of calls) expect(call.response.Code, call.action).toBe(0);
  expect(calls.filter(c => c.action === 'ListSessionEvents').every(c => c.request.Limit === 64)).toBe(true);
  await page.screenshot({ path: '/tmp/history-local-20261014/browser-local-heavy.png' });
  closing = true;
  await page.close();
});
