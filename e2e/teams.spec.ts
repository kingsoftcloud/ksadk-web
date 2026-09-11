import { expect, test } from '@playwright/test';

test('chat first, explicit details and graph, draft and focus survive the round trip', async ({ page }) => {
  await page.goto('/e2e/fixtures/teams.html');
  await expect(page.getByRole('heading', { name: '接口改造协作组' })).toBeVisible();
  await expect(page.locator('.team-sidepanel')).toHaveCount(0);
  await expect(page.locator('.team-graph-node')).toHaveCount(0);
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('草稿保持到返回聊天');
  const progress = page.getByRole('button', { name: /查看协作：/ });
  await progress.click();
  await expect(page.getByRole('complementary', { name: '本轮协作' })).toBeVisible();
  await page.getByRole('button', { name: /展开执行视图/ }).click();
  await expect(page.locator('.team-graph-node')).toHaveCount(3);
  await page.locator('.team-graph-node').filter({ hasText: '验证实现边界' }).click();
  await expect(page.getByRole('heading', { name: '验证实现边界', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('草稿保持到返回聊天');
  await expect(progress).toBeFocused();
  await page.screenshot({ path: 'output/teams-chat-desktop.png', fullPage: true });
});

test('directed and note intents are explicit, without a member send shortcut', async ({ page }) => {
  await page.goto('/e2e/fixtures/teams.html');
  await page.getByRole('combobox', { name: '接收成员' }).selectOption('engineer');
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('请检查接口兼容性');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toHaveValue('');
  const directed = await page.evaluate(() => (window as any).teamFixtureRecords.messages[0]);
  expect(directed.intent).toBe('directed'); expect(directed.mentions).toEqual(['engineer']);
  await page.getByRole('checkbox', { name: '仅留言' }).check();
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('这条只作记录');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).teamFixtureRecords.messages.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).teamFixtureRecords.messages[1].intent)).toBe('note');
});

test('same-named approvals retain the correct member reference and await authoritative confirmation', async ({ page }) => {
  await page.goto('/e2e/fixtures/teams.html?approval=1');
  await expect(page.locator('.team-sidepanel')).toHaveCount(0);
  await page.getByRole('button', { name: /项需要处理/ }).click();
  await page.locator('.team-interaction-card').filter({ hasText: '协调助手' }).getByRole('button', { name: '同意', exact: true }).click();
  await expect(page.getByText('已提交，等待执行端确认')).toBeVisible();
  const submitted = await page.evaluate(() => (window as any).teamFixtureRecords.interactions);
  expect(submitted).toHaveLength(1); expect(submitted[0].ref.memberId).toBe('leader'); expect(submitted[0].ref.sessionId).toBe('session-leader'); expect(submitted[0].ref.interactionId).toBe('same-approval');
  await page.screenshot({ path: 'output/teams-approval-desktop.png', fullPage: true });
});

test('create dialog requires a selected capable Leader and restores focus', async ({ page }) => {
  await page.goto('/e2e/fixtures/teams.html');
  const trigger = page.getByRole('button', { name: '创建测试团队' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '创建团队' });
  await dialog.getByRole('checkbox', { name: /工程师/ }).check();
  await dialog.getByLabel('群组名称').fill('评审团队');
  await dialog.getByRole('button', { name: '创建团队', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('checkbox', { name: /协调助手/ }).check();
  await dialog.getByRole('button', { name: '创建团队', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const input = await page.evaluate(() => (window as any).teamFixtureRecords.groups[0]);
  expect(input.members).toHaveLength(2); expect(input.leaderMemberId).toBe('leader');
  await expect(trigger).toBeFocused();
});

for (const width of [1024, 768, 390]) test(`responsive ${width}: details replace chat without four-column compression`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  await page.goto('/e2e/fixtures/teams.html');
  await page.getByRole('button', { name: /查看协作：/ }).click();
  if (width <= 850) await expect(page.getByRole('textbox', { name: '给团队的消息' })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `output/teams-tasks-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toBeVisible();
});

test('member inspector routes back to the group composer, including a member literally named leader', async ({ page }) => {
  await page.goto('/e2e/fixtures/teams.html');
  await page.getByRole('button', { name: /^2 位成员/ }).click();
  await page.locator('.team-member-row').filter({ hasText: '协调助手' }).click();
  await page.getByRole('button', { name: '在群内 @成员' }).click();
  await expect(page.getByRole('combobox', { name: '接收成员' })).toHaveValue('leader');
  await expect(page.getByRole('textbox', { name: '给团队的消息' })).toBeFocused();
  await page.getByRole('textbox', { name: '给团队的消息' }).fill('请解释当前分工');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).teamFixtureRecords.messages.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).teamFixtureRecords.messages[0])).toMatchObject({ intent: 'directed', mentions: ['leader'] });
});
