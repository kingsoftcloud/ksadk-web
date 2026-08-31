import { expect, test } from '@playwright/test';

test('public demo streams reasoning, tool, approval, Markdown, and feedback without a backend', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'KsADK Web 示例 Agent' })).toBeVisible();
  await expect(page.getByText('本地交互演示', { exact: true })).toBeVisible();
  await expect(page.getByText(/不会连接或冒充真实 Agent/)).toBeVisible();

  const composer = page.getByRole('textbox', { name: '演示消息' });
  const send = page.getByRole('button', { name: '发送演示消息' });
  await composer.fill('验证公开演示');
  await send.click();

  await expect(page.getByTestId('thinking-indicator')).toHaveText('正在思考…');
  await expect(page.getByTestId('thinking-indicator')).toHaveClass(/waiting-thinking-text/);
  const thinkingAnimation = page.getByTestId('thinking-indicator');
  await expect.poll(async () => thinkingAnimation.evaluate((element) => {
    const animation = element.getAnimations()[0];
    return typeof animation?.currentTime === 'number' ? animation.currentTime : 0;
  })).toBeGreaterThan(100);
  await expect(page.getByRole('button', { name: '发送演示消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /正在运行 demo\.prepare_summary/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /已完成 demo\.prepare_summary/ })).toBeVisible();

  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('允许继续生成演示结果？');
  await expect(tray).toContainText('批准后将继续流式输出');
  await page.getByTestId('interaction-approve').click();

  await expect(page.getByText('已批准继续执行。', { exact: true })).toBeVisible();
  await expect(page.getByText('已收到：“验证公开演示”。', { exact: true })).toBeVisible();
  await expect(page.getByText(/按字符增量渲染正文/)).toBeVisible();
  await expect(page.getByText('本次回复有帮助吗？')).toBeVisible();
  await page.getByRole('button', { name: '有帮助' }).click();
  await expect(page.getByRole('button', { name: '删除反馈' })).toBeVisible();
});
