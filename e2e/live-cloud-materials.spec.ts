import { test, expect, type Page } from '@playwright/test';

type Live = { metadata: { scope: { groupId: string } }; state: { sends: number; dropMaterialFinalize: boolean; materialCreates: string[]; holdMaterial: boolean; releaseMaterial?: () => void } };
const marker = { 'X-Teams-Live-Fixture': 'local-pg-only' };
const fixture = '/e2e/fixtures/live-cloud-teams.html';
async function newGoal(page: Page, goal: string) {
  await page.goto(fixture); await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await page.getByRole('textbox', { name: '团队协作目标' }).fill(goal);
}
const select = (page: Page, name: string, body: string) => page.getByLabel('选择任务材料').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });

test('actual file bytes become a ready manifest and are granted atomically with the goal', async ({ page }) => {
  const goal = `材料端云验证-${Date.now()}`; const bytes = '需要交给执行端的真实材料：产品对比\n';
  await newGoal(page, goal); await select(page, 'research.txt', bytes);
  await expect(page.getByText('材料已就绪', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/teams-real-material-ready.png', fullPage: true });
  await page.getByRole('button', { name: '开始协作', exact: true }).click();
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  const gid = await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.metadata.scope.groupId);
  const inspected = await (await page.request.get('/__fixture__/inspect', { headers: marker, params: { groupId: gid } })).json();
  const run = inspected.runs.find((row: { goal: string }) => row.goal === goal);
  expect(run._materialManifestRef).toMatch(/^tm_/);
  expect(inspected.materialGrants).toContainEqual({ materialId: run._materialManifestRef, teamRunId: run.teamRunId });
  const manifestResponse = await page.request.get(`/api/v1/teams/materials/${run._materialManifestRef}`, { headers: marker });
  expect(manifestResponse.ok()).toBe(true); const material = await manifestResponse.json();
  expect(material.state).toBe('ready'); expect(material.manifestDigest).toBe(run._materialManifestDigest);
  const blob = await page.request.get(`/api/v1/teams/materials/${material.materialId}/blobs/${encodeURIComponent(material.manifest.entries[0].digest)}`, { headers: marker });
  expect(blob.ok()).toBe(true); expect(await blob.text()).toBe(bytes);
});

test('lost finalize receipt blocks goal creation until retry recovers the original material', async ({ page }) => {
  await newGoal(page, `材料回执丢失-${Date.now()}`);
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.dropMaterialFinalize = true; });
  await select(page, 'lost-receipt.txt', `immutable input ${Date.now()}`);
  await expect(page.getByRole('button', { name: '重试上传' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始协作', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)).toBe(0);
  await page.getByRole('button', { name: '重试上传' }).click();
  await expect(page.getByText('材料已就绪', { exact: true })).toBeVisible();
  const keys = await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.materialCreates);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await expect(page.getByRole('button', { name: '开始协作', exact: true })).toBeEnabled();
});

test('cancelled upload cannot submit a goal and switching tasks clears the file selection', async ({ page }) => {
  await newGoal(page, '上传取消时保留目标草稿');
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.holdMaterial = true; });
  await select(page, 'cancelled.txt', `cancel material ${Date.now()}`);
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { liveTeams: Live }).liveTeams.state.releaseMaterial)).toBe('function');
  await page.getByRole('button', { name: '取消上传' }).click();
  await expect(page.getByRole('button', { name: '开始协作', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '团队协作目标' })).toHaveValue('上传取消时保留目标草稿');
  await page.getByRole('button', { name: '返回任务' }).click();
  await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.releaseMaterial?.());
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '任务材料' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)).toBe(0);
});

test('read-only workspace never exposes an enabled upload action', async ({ page }) => {
  await page.goto(fixture + '?readonly=1');
  await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新任务', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加材料' })).toHaveCount(0);
});
