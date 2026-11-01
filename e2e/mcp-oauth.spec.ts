import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('real Server + Kernel + LangGraph: popup consent resumes the original browser message', async ({ page, context, request }) => {
  test.skip(!process.env.MCP_LAB_EVIDENCE, 'Start through Server scripts.mcp_oauth_lab.run with MCP_LAB_BROWSER=1');
  const session = `browser-oauth-${Date.now()}`;
  let businessRequests = 0;
  const headers = { 'X-Ksc-Account-Id': 'tenant-1', 'X-Ksc-User-Uuid': 'alice' };
  const state = async () => (await request.get(`http://127.0.0.1:19993/lab/state/${session}`)).json();
  await page.route('**/agentengine/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const body = req.method() === 'POST' ? req.postDataJSON() || {} : Object.fromEntries(url.searchParams);
    const action = url.searchParams.get('Action') || url.pathname.split('/').at(-1)!;
    if (action.includes('McpAuthorization') || action === 'RetryMcpConnection') {
      const result = await request.post(`http://127.0.0.1:19992/agentengine/${action}`, { data: body, headers });
      return route.fulfill({ response: result });
    }
    if (action === 'RunAgent') {
      businessRequests += 1;
      const result = await request.post('http://127.0.0.1:19992/lab/run', { headers,
        data: { client_capability: body.Extensions?.['mcp.authorization']?.digest, session_id: session, request_id: `original-${session}`, content: '读取我的只读资料' } });
      const receipt = await result.json();
      return route.fulfill({ status: 202, json: { Code: 0, Data: { ReceiptStatus: receipt.status, CommandId: receipt.command_id, RunId: receipt.run_id, AcceptedSeq: receipt.accepted_seq } } });
    }
    if (action === 'SubscribeSessionEvents' || action === 'SubscribeRunEvents') {
      return route.continue({ url: `http://127.0.0.1:19992/lab/events/${session}?after_seq=${body.after_seq || body.AfterSeqId || body.AfterSeq || 0}${action === 'SubscribeRunEvents' ? '&run_id=' + body.InvocationId : ''}` });
    }
    {
      const result = await request.post(`http://127.0.0.1:19993/agentengine/api/v1/${action}`, {
        data: { ...body, AgentId: 'agent-1', ...(action === 'CreateSession' ? { SessionId: session } : {}) },
        headers: { 'X-AgentEngine-Identity-Namespace': 'kscloud-iam', 'X-AgentEngine-Business-Tenant-Id': 'tenant-1',
          'X-AgentEngine-Subject-Type': 'user', 'X-AgentEngine-Subject-Id': 'alice' },
      });
      expect(result.ok(), `${action}: ${await result.text()}`).toBe(true);
      return route.fulfill({ response: result });
    }
  });
  await page.goto('/');
  const input = page.locator('textarea').first();
  await input.fill('读取我的只读资料');
  await input.press('Enter');
  await expect(page.getByTestId('mcp-authorization-card')).toBeVisible({ timeout: 30000 });
  await input.fill('等待期间保留的草稿');
  await input.press('Enter');
  await expect(input).toHaveValue('等待期间保留的草稿');
  expect(businessRequests).toBe(1);
  await input.fill('');
  const before = await state();
  expect(before.steps).toBe(1);
  const waitId = before.waits[0].wait_id;
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: '打开授权', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: '模拟 IAM', exact: true })).toBeVisible();
  // Closing the IAM window is not a denial or success fact.
  await popup.close();
  await page.getByRole('button', { name: '查询状态', exact: true }).click();
  await expect(page.getByText('等待你授权 MCP 服务')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('mcp-authorization-card')).toBeVisible({ timeout: 15000 });
  // Simulate the browser's popup blocker, then recover with the same wait.
  await page.evaluate(() => { (window as any).__savedOpen = window.open; window.open = () => null; });
  await page.getByRole('button', { name: '打开授权', exact: true }).click();
  await expect(page.getByText('浏览器拦截了授权窗口。请允许弹窗后再次点击打开授权。')).toBeVisible();
  await page.evaluate(() => { window.open = (window as any).__savedOpen; delete (window as any).__savedOpen; });
  const deniedPopup = context.waitForEvent('page');
  await page.getByRole('button', { name: '打开授权', exact: true }).press('Enter');
  const denial = await deniedPopup;
  await denial.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText('授权未完成，可重新授权')).toBeVisible({ timeout: 15000 });
  const nextPopup = context.waitForEvent('page');
  await page.getByRole('button', { name: '重新授权', exact: true }).click();
  const consent = await nextPopup;
  await consent.getByRole('button', { name: '允许只读访问' }).click();
  await expect.poll(async () => (await state()).events.some((e: any) => e.event_type === 'run.completed'), { timeout: 30000 }).toBe(true);
  await expect(page.getByText(/alice/).first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('读取我的只读资料', { exact: true })).toBeVisible();
  const after = await state();
  expect(businessRequests).toBe(1); expect(after.steps).toBe(1);
  expect(after.waits[0].wait_id).toBe(waitId);
  expect(after.waits[0].native_target).toEqual(before.waits[0].native_target);
  await input.fill('恢复后的新草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await input.fill('');
  await page.screenshot({ path: `${process.env.MCP_LAB_EVIDENCE}/browser.png`, fullPage: true });
  writeFileSync(`${process.env.MCP_LAB_EVIDENCE}/browser-report.json`, JSON.stringify({ businessRequests, steps: after.steps, waitId, refreshed: true, windowClosed: true, popupBlocked: true, keyboardAction: true, denialThenRetry: true, draftPreservedWhileWaiting: true, inputRestored: true }));
});
