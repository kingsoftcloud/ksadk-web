import { test, expect, type Page } from '@playwright/test';
const marker = { 'X-Teams-Live-Fixture': 'local-pg-only' };
const path = '/e2e/fixtures/live-cloud-teams.html?readonly=1';
const status = (page: Page) => page.getByRole('status', { name: 'Leader 接管状态' });
async function setState(page: Page, state: string) {
  const response = await page.request.post('/__fixture__/standby', { headers: marker, data: { state } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).fixture).toBe('projection-only-no-host-execution');
}

test('real PG snapshot and SSE render all standby phases without offering a replacement action', async ({ page }) => {
  await page.goto(path); await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await setState(page, 'armed'); await expect(status(page)).toContainText('已配置备用 Leader');
  for (const [phase, label] of [
    ['fencing_old', '正在停止原 Leader'], ['waiting_old_grant', '等待原授权失效'], ['activating', '正在启动备用 Leader'],
    ['active', '备用 Leader 已接管'], ['blocked', 'Leader 接管暂时受阻'],
  ]) {
    await setState(page, phase); await expect(status(page)).toContainText(label);
    await expect(status(page).getByRole('button')).toHaveCount(0);
  }
  await expect(status(page)).toContainText('核对后才能继续接管');
  await page.reload(); await expect(status(page)).toContainText('Leader 接管暂时受阻');
  await expect(status(page)).toHaveAttribute('data-state', 'blocked');
  await page.screenshot({ path: 'test-results/teams-real-standby-blocked.png', fullPage: true });
});

test('switching run drops previous takeover state and a late real history page cannot restore it', async ({ page }) => {
  await page.goto(path); await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await setState(page, 'waiting_old_grant'); await expect(status(page)).toContainText('等待原授权失效');
  await page.evaluate(() => { (window as unknown as { liveTeams: { state: { holdPage: boolean } } }).liveTeams.state.holdPage = true; });
  await page.getByRole('button', { name: '查看更早的消息' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { liveTeams: { state: { releasePage?: () => void } } }).liveTeams.state.releasePage))).toBe(true);
  await page.getByRole('button', { name: /切换任务隔离验证/ }).click();
  await expect(page.getByRole('heading', { name: '切换任务隔离验证', exact: true })).toBeVisible();
  await expect(status(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { liveTeams: { state: { releasePage?: () => void } } }).liveTeams.state.releasePage?.());
  await setState(page, 'blocked');
  await expect(status(page)).toHaveCount(0);
  await page.getByRole('button', { name: /接口与分页验证/ }).click();
  await expect(status(page)).toContainText('Leader 接管暂时受阻');
  await expect(status(page)).toContainText('核对后才能继续接管');
});
