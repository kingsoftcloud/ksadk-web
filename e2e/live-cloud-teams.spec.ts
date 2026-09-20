import { test, expect, type Page } from '@playwright/test';

type Live = { state: { dropReceipt: boolean; skipEvents: number; snapshots: number; sends: number; lookups: number; pages: number; holdSend: boolean; releaseSend?: () => void; holdPage: boolean; releasePage?: () => void }; metadata: { scope: { groupId: string; authorityId: string; ownerScopeRef: string }; runs: string[] } };
const live = (page: Page) => page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.metadata);
const path = '/e2e/fixtures/live-cloud-teams.html';
const marker = { 'X-Teams-Live-Fixture': 'local-pg-only' };
async function inspect(page: Page) { const meta = await live(page); const response = await page.request.get('/__fixture__/inspect', { headers: marker, params: { groupId: meta.scope.groupId } }); expect(response.ok()).toBe(true); return response.json(); }

test.beforeEach(async ({ page }) => { await page.goto(path); await expect(page.getByRole('heading', { name: '接口与分页验证', exact: true })).toBeVisible(); await expect(page.getByText('实时连接', { exact: true })).toBeVisible(); });

test('decodes actual PG snapshot and stable message pages with strict selected-run isolation', async ({ page }) => {
  await expect(page.getByText('真实数据库历史消息 00', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看更早的消息' }).click();
  await expect(page.getByText('真实数据库历史消息 00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /切换任务隔离验证/ }).click();
  await expect(page.getByRole('heading', { name: '切换任务隔离验证', exact: true })).toBeVisible();
  await expect(page.getByText('真实数据库历史消息 00', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/teams-real-pg-workspace.png', fullPage: true });
});

test('refresh looks up an actually committed lost receipt without creating a second goal', async ({ page }) => {
  const text = `原单刷新恢复-${Date.now()}`;
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.dropReceipt = true; });
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await page.getByRole('textbox', { name: '团队协作目标' }).fill(text);
  await page.getByRole('button', { name: '开始协作' }).click();
  await expect(page.getByText('接收结果未确认', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)).toBe(0);
  expect((await inspect(page)).runs.filter((run: { goal: string }) => run.goal === text)).toHaveLength(1);
});

test('two browser tabs persist one intent and Server has exactly one matching goal', async ({ page, context }) => {
  const other = await context.newPage(); await other.goto(path); await expect(other.getByText('实时连接', { exact: true })).toBeVisible();
  const text = `双标签唯一操作-${Date.now()}`;
  for (const tab of [page, other]) {
    await tab.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.holdSend = true; });
    await tab.getByRole('button', { name: '新任务', exact: true }).click();
    await tab.getByRole('textbox', { name: '团队协作目标' }).fill(text);
  }
  await Promise.all([page, other].map(tab => tab.getByRole('button', { name: '开始协作' }).click()));
  const sends = async () => (await Promise.all([page, other].map(tab => tab.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)))).reduce((a,b) => a+b,0);
  await expect.poll(sends).toBe(1);
  for (const tab of [page, other]) await tab.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.releaseSend?.());
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  expect((await inspect(page)).runs.filter((run: { goal: string }) => run.goal === text)).toHaveLength(1);
});

test('missing a real SSE event triggers a fresh snapshot and restores subsequent committed messages', async ({ page }) => {
  const meta = await live(page); const before = await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.snapshots);
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.skipEvents = 1; });
  const text = `事件恢复-${Date.now()}`;
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post(`/api/v1/groups/${meta.scope.groupId}/messages`, { headers: marker, data: { intent: 'note', teamRunId: meta.runs[0], parts: [{ kind: 'text', text: `${text}-${index}` }], idempotencyKey: `${text}-${index}` } });
    expect(response.ok()).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.snapshots)).toBeGreaterThan(before);
  await expect(page.getByText(`${text}-1`, { exact: true })).toBeVisible();
});

test('a late real page from the previous run never overwrites the selected run', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.holdPage = true; });
  await page.getByRole('button', { name: '查看更早的消息' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { liveTeams: Live }).liveTeams.state.releasePage))).toBe(true);
  await page.getByRole('button', { name: /切换任务隔离验证/ }).click();
  await expect(page.getByRole('heading', { name: '切换任务隔离验证', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.releasePage?.());
  await expect(page.getByText('真实数据库历史消息 00', { exact: true })).toHaveCount(0);
});

test('opens at the latest message and preserves a reading anchor across history and real SSE refresh', async ({ page }) => {
  const panel = page.getByRole('tabpanel', { name: '消息', exact: true });
  const distanceFromBottom = () => panel.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(distanceFromBottom).toBeLessThan(2);
  await panel.evaluate(node => { node.scrollTop = 0; });
  const anchor = await panel.locator('[data-message-id]').first().getAttribute('data-message-id');
  const offset = () => panel.locator(`[data-message-id="${anchor}"]`).evaluate(node => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top);
  const initialOffset = await offset();
  await page.getByRole('button', { name: '查看更早的消息' }).click();
  await expect(page.getByText('真实数据库历史消息 00', { exact: true })).toHaveCount(1);
  await expect.poll(offset).toBeCloseTo(initialOffset, 0);
  const meta = await live(page); const text = `保留阅读位置-${Date.now()}`;
  const response = await page.request.post(`/api/v1/groups/${meta.scope.groupId}/messages`, { headers: marker, data: { intent: 'note', teamRunId: meta.runs[0], parts: [{ kind: 'text', text }], idempotencyKey: text } });
  expect(response.ok()).toBe(true);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await expect.poll(offset).toBeCloseTo(initialOffset, 0);
  await expect.poll(distanceFromBottom).toBeGreaterThan(100);
  await page.getByRole('button', { name: /切换任务隔离验证/ }).click();
  await page.getByRole('button', { name: /接口与分页验证/ }).click();
  await expect.poll(distanceFromBottom).toBeLessThan(2);
});
