import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/e2e/fixtures/cloud-teams.html'); await expect(page.getByRole('heading', { name: '评估端云协同架构并提交报告', exact: true })).toBeVisible(); });
test('pages history, switches run without leakage, and shows node availability', async ({ page }) => {
  await page.getByRole('button', { name: '查看更早的消息' }).click(); await expect(page.getByText('这是一条按需加载的更早消息。')).toBeVisible();
  await page.getByRole('button', { name: /核对上一轮测试结果/ }).click(); await expect(page.getByText('这里只展示上一轮协作的消息。')).toBeVisible(); await expect(page.getByText('这是一条按需加载的更早消息。')).toHaveCount(0);
  await page.getByRole('tab', { name: '成员' }).click(); await expect(page.getByText('本地节点离线，等待重新连接')).toBeVisible(); await expect(page.getByText(/云端节点/)).toBeVisible();
  await page.screenshot({ path: 'test-results/cloud-teams-members.png', fullPage: true });
});
test('loads approval detail before response and honors read-only degradation', async ({ page }) => {
  await page.getByRole('tab', { name: /待处理/ }).click(); await expect(page.getByText('选择本次调研的范围后继续。')).toHaveCount(0); await page.getByRole('button', { name: '查看并处理' }).click(); await expect(page.getByText('选择本次调研的范围后继续。')).toBeVisible();
  await page.getByRole('radio', { name: /端云协同/ }).check(); await page.getByRole('button', { name: '切换只读' }).click(); await expect(page.getByRole('button', { name: '提交', exact: true })).toBeDisabled(); await expect(page.getByText('只读 ·', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/cloud-teams-readonly.png', fullPage: true });
});
test('recovers a lost receipt after refresh without sending the original goal twice', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { fixtureCloud: { setUncertain: (value: boolean) => void } }).fixtureCloud.setUncertain(true));
  await page.getByRole('button', { name: '新任务', exact: true }).click(); await page.getByRole('textbox', { name: '团队协作目标' }).fill('唯一目标：验证刷新后的查单恢复'); await page.getByRole('button', { name: '开始协作' }).click();
  await expect(page.getByText('接收结果未确认', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '开始协作' })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(1);
  await page.reload(); await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(0);
});
test('stays within a narrow viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole('tab', { name: '消息', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/cloud-teams-mobile.png', fullPage: true });
});

test('loads full task details on demand and constructs scoped artifact links', async ({ page }) => {
  await page.getByRole('tab', { name: '任务', exact: true }).click(); await expect(page.getByText('验证运行时身份和审批引用不会串用。')).toHaveCount(0);
  await page.getByRole('button', { name: /核对接口契约/ }).click(); await expect(page.getByText('验证运行时身份和审批引用不会串用。')).toBeVisible();
  await page.getByRole('tab', { name: '交付物' }).click(); await expect(page.getByRole('link', { name: '下载' })).toHaveAttribute('href', /\/api\/v1\/groups\/fixture-group\/artifacts\/run-a-artifact\/content\?.*teamRunId=run-a/);
});

test('reconnects observation without resending a draft', async ({ page }) => {
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('断线期间保留的草稿');
  await page.evaluate(() => (window as unknown as { fixtureCloud: { disconnect: () => void } }).fixtureCloud.disconnect());
  await expect(page.getByText('正在恢复连接 · 执行状态待同步')).toBeVisible();
  await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('断线期间保留的草稿');
  expect(await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(0);
});

test('resolves an uncertain goal in place and clears its submitted draft', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { fixtureCloud: { setUncertain: (value: boolean) => void } }).fixtureCloud.setUncertain(true));
  await page.getByRole('button', { name: '新任务', exact: true }).click(); await page.getByRole('textbox', { name: '团队协作目标' }).fill('核对后清理本次目标草稿'); await page.getByRole('button', { name: '开始协作' }).click();
  await expect(page.getByText('接收结果未确认', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '核对待确认操作' }).click();
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible(); await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(1);
});

test('a late receipt does not switch the selected run or clear another run draft', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { fixtureCloud: { setUncertain: (value: boolean) => void } }).fixtureCloud.setUncertain(true));
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('原任务已提交的补充'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('接收结果未确认', { exact: true })).toBeVisible(); await page.getByRole('button', { name: /核对上一轮测试结果/ }).click();
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('另一项任务的草稿'); await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '核对上一轮测试结果', exact: true })).toBeVisible(); await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('另一项任务的草稿');
  await page.getByRole('button', { name: /评估端云协同架构并提交报告/ }).click(); await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('');
});


test('two tabs share a single pending intent and only one sender owns its lease', async ({ page, context }) => {
  const second = await context.newPage(); await second.goto('/e2e/fixtures/cloud-teams.html');
  await expect(second.getByText('实时连接', { exact: true })).toBeVisible();
  for (const tab of [page, second]) {
    await tab.evaluate(() => (window as unknown as { fixtureCloud: { holdSend: () => void } }).fixtureCloud.holdSend());
    await tab.getByRole('button', { name: '新任务', exact: true }).click();
    await tab.getByRole('textbox', { name: '团队协作目标' }).fill('同一意图只创建一次');
  }
  await Promise.all([page, second].map(tab => tab.getByRole('button', { name: '开始协作' }).click()));
  const sendCount = async () => (await Promise.all([page, second].map(tab => tab.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)))).reduce((a, b) => a + b, 0);
  await expect.poll(sendCount).toBe(1);
  for (const tab of [page, second]) await tab.evaluate(() => (window as unknown as { fixtureCloud: { releaseSend: () => void } }).fixtureCloud.releaseSend());
  for (const tab of [page, second]) {
    await tab.getByRole('button', { name: '核对待确认操作' }).click();
    await expect(tab.getByText('服务端已接收', { exact: true })).toBeVisible();
  }
  expect(await sendCount()).toBe(1);
});

test('a gap in real SSE decoding refetches the snapshot and preserves the draft', async ({ page }) => {
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('事件缺口期间保留草稿');
  const before = await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { snapshots: number } } }).fixtureCloud.counters.snapshots);
  await page.evaluate(() => (window as unknown as { fixtureCloud: { emitGap: () => void } }).fixtureCloud.emitGap());
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { snapshots: number } } }).fixtureCloud.counters.snapshots)).toBeGreaterThan(before);
  await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('事件缺口期间保留草稿');
});

test('a delayed page from another run never enters the current history', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { fixtureCloud: { holdPage: () => void } }).fixtureCloud.holdPage());
  await page.getByRole('button', { name: '查看更早的消息' }).click();
  await page.getByRole('button', { name: /核对上一轮测试结果/ }).click();
  await expect(page.getByText('这里只展示上一轮协作的消息。')).toBeVisible();
  await page.evaluate(() => (window as unknown as { fixtureCloud: { releasePage: () => void } }).fixtureCloud.releasePage());
  await expect(page.getByText('这是一条按需加载的更早消息。')).toHaveCount(0);
});

test('a delayed mutation receipt cannot navigate back or erase another run draft', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { fixtureCloud: { holdSend: () => void } }).fixtureCloud.holdSend());
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('发给原任务的补充');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(1);
  await page.getByRole('button', { name: /核对上一轮测试结果/ }).click();
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('另一项任务还未提交的内容');
  await page.evaluate(() => (window as unknown as { fixtureCloud: { releaseSend: () => void } }).fixtureCloud.releaseSend());
  await page.getByRole('button', { name: '核对待确认操作' }).click();
  await expect(page.getByText('服务端已接收', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '核对上一轮测试结果', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('另一项任务还未提交的内容');
});


test('browser offline state disables sending while allowing draft editing', async ({ page, context }) => {
  await context.setOffline(true);
  await expect(page.getByText('只读 · 浏览器已离线，草稿与待确认操作会保留。')).toBeVisible();
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('离线保存的编辑内容');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { fixtureCloud: { counters: { send: number } } }).fixtureCloud.counters.send)).toBe(0);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('离线保存的编辑内容');
});

test('unchecked actual catalog entries can request Leader validation without claiming capability', async ({ page }) => {
  await page.goto('/e2e/fixtures/create-cloud-team.html');
  await page.getByRole('textbox', { name: '团队名称' }).fill('待验证团队');
  for (const name of ['cloud-a', 'cloud-b']) await page.getByRole('checkbox', { name: new RegExp(name) }).check();
  const leader = page.getByRole('combobox', { name: '指定 Leader' });
  await expect(leader).toBeEnabled(); await expect(leader.getByRole('option', { name: 'cloud-a · 创建时验证' })).toHaveCount(1);
  await expect(page.getByText('可担任 Leader', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服务端验证');
  await expect(page.getByRole('textbox', { name: '团队名称' })).toHaveValue('待验证团队');
  const submissions = await page.evaluate(() => (window as unknown as { candidateSubmissions: { leaderMemberId: string; members: { bindingRef: string }[] }[] }).candidateSubmissions);
  expect(submissions).toHaveLength(1); expect(submissions[0].leaderMemberId).toBe('cloud-a');
  expect(submissions[0].members[0].bindingRef).toBe('cloud-agent:cloud-a:version-1');
});

test('verified non-Leader members never become Leader candidates', async ({ page }) => {
  await page.goto('/e2e/fixtures/create-cloud-team.html?ready=1');
  for (const name of ['cloud-a', 'cloud-b']) await page.getByRole('checkbox', { name: new RegExp(name) }).check();
  await expect(page.getByRole('combobox', { name: '指定 Leader' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '指定 Leader' }).getByRole('option')).toHaveCount(1);
});

test('unchecked standby remains explicitly pending same-release validation', async ({ page }) => {
  await page.goto('/e2e/fixtures/create-cloud-team.html?standby=1');
  await page.getByRole('textbox', { name: '团队名称' }).fill('备用待验证');
  await page.getByRole('checkbox', { name: /本地协调者/ }).check(); await page.getByRole('checkbox', { name: /cloud-a/ }).check();
  await page.getByText('本地离线时继续协作', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Leader 云端备用' }).selectOption('cloud-agent:cloud-b:version-1');
  await expect(page.getByText(/服务端验证同一发布及实际执行能力后/)).toBeVisible();
  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服务端验证');
  const values = await page.evaluate(() => (window as unknown as { candidateSubmissions: { leaderStandbyBindingRef: string }[] }).candidateSubmissions);
  expect(values[0].leaderStandbyBindingRef).toBe('cloud-agent:cloud-b:version-1');
});

test('local mode still requires its existing enqueue capability', async ({ page }) => {
  await page.goto('/e2e/fixtures/create-cloud-team.html?local=1');
  await expect(page.getByRole('checkbox', { name: /cloud-a/ })).toBeDisabled();
});
