import { expect, test } from '@playwright/test';

test('public demo visibly streams reasoning, a tool, and Markdown without a backend', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'KsADK Web 示例 Agent' })).toBeVisible();
  await expect(page.getByText('本地交互演示', { exact: true })).toBeVisible();
  await expect(page.getByText(/不会连接或冒充真实 Agent/)).toBeVisible();

  const composer = page.getByRole('textbox', { name: '演示消息' });
  const send = page.getByRole('button', { name: '发送演示消息' });
  await composer.fill('验证公开演示');
  await send.click();

  await expect(page.getByTestId('thinking-indicator')).toHaveText('正在思考');
  await expect(page.getByTestId('thinking-indicator')).toHaveClass(/waiting-thinking-text/);
  await expect(page.getByRole('button', { name: '发送演示消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /正在运行 demo\.echo_context/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /已完成 demo\.echo_context/ })).toBeVisible();
  await expect(page.getByText('已收到：“验证公开演示”。')).toBeVisible();
  await expect(page.getByText(/组件会消费同一套会话、思考、工具、审批与 A2UI 协议/)).toBeVisible();
});
