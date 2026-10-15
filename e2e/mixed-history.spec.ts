import { expect, test } from '@playwright/test';

for (const version of ['new', 'old']) {
  test(`${version} Runtime: actual pages match browser transcript across pagination and session switches`, async ({ page }) => {
    const replies: Array<{ action: string; request: any; body: any }> = [];
    page.on('response', async response => {
      if (!response.url().includes('/agentengine/api/v1/')) return;
      try {
        replies.push({ action: response.url().split('/').pop()!,
          request: response.request().postDataJSON(), body: await response.json() });
      } catch { /* Aborted requests have no readable response. */ }
    });
    await page.goto(`/e2e/fixtures/mixed-history.html?version=${version}`);
    await page.getByRole('button', { name: 'Open 100000', exact: true }).click();
    const probe = () => page.evaluate(() => (window as any).mixedHistoryProbe());
    await expect.poll(async () => (await probe()).messages.some((row: any) => row.content === 'append-100')).toBe(true);
    await expect(page.getByText('append-100', { exact: true })).toBeVisible();
    await expect.poll(() => replies.filter(row => row.action === 'ListSessionMessages').length).toBeGreaterThan(0);
    const first = replies.find(row => row.action === 'ListSessionMessages')!;
    const firstIds = first.body.Data.Messages.map((row: any) => row.MessageId);
    await page.getByRole('button', { name: 'Older', exact: true }).click();
    await expect.poll(async () => (await probe()).history[`mixed-${version}-100000`]?.isLoadingOlder).toBe(false);
    await expect.poll(() => replies.filter(row => row.action === 'ListSessionMessages').length).toBeGreaterThan(1);
    const loaded = await probe();
    expect(new Set(loaded.messages.map((row: any) => row.id)).size).toBe(loaded.messages.length);
    // Every visible text must come from the actual pages; none may be invented,
    // lost by merging feedback, or borrowed from a previously selected session.
    const pages = replies.filter(row => row.action === 'ListSessionMessages');
    const expected = [...pages].reverse().flatMap(row => row.body.Data.Messages.map((message: any) => message.Content.text));
    expect(loaded.messages.map((row: any) => row.content)).toEqual([...new Set(expected)]);
    expect(firstIds.length).toBe(50);
    await page.getByRole('button', { name: 'Reveal append-50', exact: true }).click();
    await expect(page.getByText('append-50', { exact: true })).toBeVisible();
    for (const size of [100, 10000, 100000, 100]) {
      await page.getByRole('button', { name: `Open ${size}`, exact: true }).click();
      await expect.poll(async () => (await probe()).current).toBe(`mixed-${version}-${size}`);
      if (size === 100000) {
        await expect.poll(async () => (await probe()).messages.some((row: any) => row.content === 'append-100')).toBe(true);
        expect((await probe()).messages.every((row: any) => String(row.content).startsWith('append-')
          || String(row.content).startsWith(`${version}:100000:`))).toBe(true);
        await expect(page.getByText('append-100', { exact: true })).toBeVisible();
      } else {
        await expect.poll(async () => (await probe()).messages.some((row: any) =>
          String(row.content).startsWith(`${version}:${size}:`))).toBe(true);
        expect((await probe()).messages.every((row: any) => String(row.content).startsWith(`${version}:${size}:`))).toBe(true);
        await expect(page.locator('main')).toContainText(`${version}:${size}:`);
      }
    }
    for (const row of replies.filter(row => ['ListSessionMessages', 'ListSessionEvents'].includes(row.action))) {
      expect(row.body.Code).toBe(0);
    }
    await page.screenshot({ path: `test-results/mixed-${version}-history.png` });
  });
}
