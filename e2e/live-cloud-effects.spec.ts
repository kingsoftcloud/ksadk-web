import { test, expect, type Page } from '@playwright/test';

type Live = { state: { dropReceipt: boolean; sends: number }; metadata: { scope: { groupId: string }; runs: string[]; keys: Record<string, string> } };
const path = '/e2e/fixtures/live-cloud-teams.html?effects=1';
const marker = { 'X-Teams-Live-Fixture': 'local-pg-only' };
const metadata = (page: Page) => page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.metadata);
const card = (page: Page, name: string) => page.locator('.team-effect-card').filter({ has: page.getByText(name, { exact: true }) });
async function open(page: Page, readonly = false) {
  await page.goto(path + (readonly ? '&readonly=1' : ''));
  await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '执行核查', exact: true }).click();
  await expect(page.getByRole('heading', { name: '外部操作核查', exact: true })).toBeVisible();
}
async function review(page: Page, name: string, reason: string) {
  await card(page, name).getByRole('button', { name: '记录核查决定' }).click();
  await page.getByRole('textbox', { name: '核查说明' }).fill(reason);
  await page.getByRole('checkbox', { name: '我已核对外部记录，接受剩余不确定性并允许后续处理。' }).check();
}

test('real PG effect decision survives lost HTTP receipt and refresh with one audited resolution', async ({ page }) => {
  await open(page);
  const reason = '已查看受控外部计数器，保留原请求并接受此次不确定性。';
  await review(page, '核查回执恢复', reason);
  await page.evaluate(() => { (window as unknown as { liveTeams: Live }).liveTeams.state.dropReceipt = true; });
  await page.locator('form.team-effect-form').getByRole('button', { name: '记录核查决定' }).click();
  await expect(page.getByText('接收结果未确认', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '执行核查' }).click();
  await expect(card(page, '核查回执恢复')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)).toBe(0);
  const meta = await metadata(page);
  const response = await page.request.get('/__fixture__/inspect', { headers: marker, params: { groupId: meta.scope.groupId } });
  expect(response.ok()).toBe(true);
  const records = await response.json();
  expect(records.effectResolutions.filter((row: { audit: { reason: string } }) => row.audit.reason === reason)).toHaveLength(1);
  const effect = records.effects.find((row: { effectKey: string }) => row.effectKey === meta.keys['核查回执恢复']);
  expect(effect.phase).toBe('resolved'); expect(effect.outcome).toBeNull();
});

test('another tab changes actual evidence and preserves the first tabs unsent review text', async ({ page, context }) => {
  await open(page); const other = await context.newPage(); await open(other);
  const draft = '这段核查说明在收到另一标签页的新决定后仍须保留。';
  await review(page, '多标签证据更新', draft);
  await review(other, '多标签证据更新', '第二标签页已完成实际外部核对。');
  await other.locator('form.team-effect-form').getByRole('button', { name: '记录核查决定' }).click();
  await expect(other.getByText('服务端已接收', { exact: true })).toBeVisible();
  await expect(page.getByText('记录已更新，核查说明已保留。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '核查说明' })).toHaveValue(draft);
  await expect(page.locator('form.team-effect-form').getByRole('button', { name: '记录核查决定' })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { liveTeams: Live }).liveTeams.state.sends)).toBe(0);
  await page.screenshot({ path: 'test-results/teams-real-effect-evidence-changed.png', fullPage: true });
  await other.close();
});

test('real effect history stays read only and selected run changes never mix execution evidence', async ({ page }) => {
  await open(page, true);
  await expect(card(page, '只读与跨任务隔离').getByRole('button')).toBeDisabled();
  const meta = await metadata(page); const goal = `核查隔离任务-${Date.now()}`;
  const result = await page.request.post(`/api/v1/groups/${meta.scope.groupId}/messages`, { headers: marker, data: { intent: 'start_goal', parts: [{ kind: 'text', text: goal }], idempotencyKey: goal } });
  expect(result.ok()).toBe(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(goal) }).click();
  await expect(page.getByText('当前任务没有待核查的外部操作。')).toBeVisible();
  await expect(card(page, '只读与跨任务隔离')).toHaveCount(0);
  await page.getByRole('button', { name: /Research/ }).click();
  await expect(card(page, '只读与跨任务隔离')).toBeVisible();
  await expect(card(page, '只读与跨任务隔离').getByRole('button')).toBeDisabled();
});

test('contrary late Host evidence permits a new owner CAS decision while retaining the original audit and outcome', async ({ page }) => {
  await open(page);
  const name = '迟到证据再次核查';
  await expect(card(page, name).getByText('核查后收到不同证据')).toBeVisible();
  await expect(card(page, name).getByRole('button', { name: '记录核查决定' })).toBeEnabled();
  const meta = await metadata(page); const effectKey = meta.keys[name];
  const inspect = async () => {
    const response = await page.request.get('/__fixture__/inspect', { headers: marker, params: { groupId: meta.scope.groupId } });
    expect(response.ok()).toBe(true); return response.json();
  };
  const before = await inspect();
  const original = before.effects.find((row: { effectKey: string }) => row.effectKey === effectKey);
  const oldAudit = before.effectResolutions.find((row: { receipt: { effectKey: string } }) => row.receipt.effectKey === effectKey);
  expect(original.phase).toBe('resolved'); expect(original.resolutionConflict).toBe(true);
  expect(oldAudit.audit.decision).toBe('confirmed_not_applied');
  expect(oldAudit.audit.verifiedOutcome.phase).toBe('failed');
  expect(original.outcome.phase).toBe('completed');
  expect(original.outcome.evidence_ref).toBe('fixture-late-host-applied');

  // An old proof cannot overwrite this evidence even when supplied with a new key.
  const stale = await page.request.post(`/api/v1/groups/${meta.scope.groupId}/effects/${effectKey}/reconcile`, {
    headers: marker, data: { expectedRevision: oldAudit.audit.expectedRevision, expectedEvidenceDigest: oldAudit.audit.expectedEvidenceDigest,
      decision: 'accept_risk', evidenceRef: 'manual-review:stale-proof', reason: '旧证据不得覆盖迟到结果。', idempotencyKey: `stale-proof-${Date.now()}` },
  });
  expect(stale.ok()).toBe(true);
  expect(await stale.json()).toMatchObject({ status: 'rejected', code: 'effect_revision_conflict' });
  expect((await inspect()).effectResolutions.filter((row: { receipt: { effectKey: string } }) => row.receipt.effectKey === effectKey)).toHaveLength(1);

  const reason = '已重新核对迟到的原执行证据，保留两次核查结论并接受继续处理。';
  await review(page, name, reason);
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/effects/${effectKey}/reconcile`));
  await page.locator('form.team-effect-form').getByRole('button', { name: '记录核查决定' }).click();
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ expectedRevision: original.revision, expectedEvidenceDigest: original.evidenceDigest, decision: 'accept_risk', reason });
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  await expect(card(page, name)).toHaveCount(0);
  const after = await inspect();
  const updated = after.effects.find((row: { effectKey: string }) => row.effectKey === effectKey);
  const audits = after.effectResolutions.filter((row: { receipt: { effectKey: string } }) => row.receipt.effectKey === effectKey);
  expect(audits).toHaveLength(2); expect(audits).toContainEqual(oldAudit);
  expect(updated.phase).toBe('resolved'); expect(updated.resolutionConflict).toBe(false);
  expect(updated.revision).toBe(original.revision + 1);
  expect(updated.outcome).toEqual(original.outcome); expect(updated.evidenceDigest).toBe(original.evidenceDigest);
  expect(updated.resolution).toMatchObject({ decision: 'accept_risk', expectedRevision: original.revision, expectedEvidenceDigest: original.evidenceDigest, reason, verifiedOutcome: null });
  expect(updated.resolution.resolutionId).not.toBe(oldAudit.audit.resolutionId);
  await page.reload(); await page.getByRole('tab', { name: '执行核查' }).click();
  await expect(card(page, name)).toHaveCount(0);
  expect((await inspect()).effectResolutions.filter((row: { receipt: { effectKey: string } }) => row.receipt.effectKey === effectKey)).toHaveLength(2);
});
