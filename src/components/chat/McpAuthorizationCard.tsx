import { useCallback, useEffect, useState } from 'react';
import type { McpAuthorizationAction, McpAuthorizationRequest, McpAuthorizationSnapshot } from '../../core/mcp-authorization/types.js';
import { MCP_AUTHORIZATION_CAPABILITY } from '../../core/mcp-authorization/contract.js';
import { authorizationInteraction } from '../../core/mcp-authorization/normalize.js';
import { sharedInteractionStore } from '../../core/interaction/index.js';
const labels: Record<string, string> = {
  preparing: '正在保存任务等待点', awaiting_authorization: '等待你授权 MCP 服务',
  authorization_failed: '授权未完成，可重新授权', credential_ready: '授权已收到，正在连接服务',
  connecting: '正在恢复原任务', connection_failed: '连接失败，凭证已保留',
  resume_unknown: '恢复结果暂时无法确认，任务已保留，请勿重新提交',
  resumed: '已恢复原任务', cancelled: '任务已取消', expired: '授权等待已过期', failed: '授权失败',
};
const reasons: Record<string, string> = {
  MCP_CONFIGURATION_NOT_FOUND: '当前任务没有这个 MCP 连接，请开发者检查 Agent 版本。',
  MCP_CLIENT_NOT_FOUND: '客户端凭据引用无效，请开发者重新发布配置。',
  OAUTH_CLIENT_INCOMPATIBLE: '该 MCP 的客户端登记未通过，请开发者检查接入配置。',
  OAUTH_DISCOVERY_FAILED: '暂时无法获取 MCP 授权信息，请稍后重试。',
  OAUTH_ISSUER_MISMATCH: '授权服务信息不一致，平台未接受此次授权。',
  OAUTH_UNEXPECTED_SCOPE: '授权范围与 Agent 声明不一致，请开发者检查配置。',
  INSUFFICIENT_SCOPE: '授权范围不足，请开发者检查申请的权限。',
  BUSINESS_PERMISSION_DENIED: '当前账号没有执行该业务操作的权限。',
  ACCOUNT_AUTHORIZATION_DENIED: 'IAM 拒绝了当前账号的授权，请检查账号权限。',
  AUTHORIZATION_DENIED: '你已拒绝授权，可以重新授权或取消任务。',
  INVALID_BROWSER_BINDING: '授权窗口已失效，请从原对话重新打开。',
  MCP_OAUTH_ADMISSION_CLOSED: '平台暂时停止接受新授权，请稍后重试。',
};
export function authorizationErrorMessage(value: unknown): string {
  if (typeof value === 'string') return reasons[value] || '操作未确认，请查询最新状态后重试。';
  if (value && typeof value === 'object') {
    const error = value as { code?: string; reasonCode?: string; message?: string };
    return reasons[error.code || error.reasonCode || error.message || ''] || '操作未确认，请查询最新状态后重试。';
  }
  return '操作未确认，请查询最新状态后重试。';
}
export function McpAuthorizationCard({ snapshot, sessionId, request }: {
  snapshot: McpAuthorizationSnapshot; sessionId: string; request?: McpAuthorizationRequest;
}) {
  const [current, setCurrent] = useState(snapshot);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = snapshot.capability_digest === MCP_AUTHORIZATION_CAPABILITY.digest && Boolean(request);
  const accept = useCallback((value: McpAuthorizationSnapshot) => {
    if (value.wait_id !== snapshot.wait_id || value.run_id !== snapshot.run_id) throw new Error('授权任务不匹配');
    setCurrent(previous => value.revision >= previous.revision ? value : previous);
    const interaction = authorizationInteraction(value, sessionId, snapshot.run_id);
    if (interaction) sharedInteractionStore.upsert(interaction);
  }, [sessionId, snapshot.run_id, snapshot.wait_id]);
  useEffect(() => { setCurrent(previous => snapshot.revision >= previous.revision ? snapshot : previous); }, [snapshot]);
  useEffect(() => {
    if (!supported || !request) return;
    let disposed = false;
    const query = async () => {
      try { const result = await request('GetMcpAuthorizationWait', snapshot.wait_id); if (!disposed) accept(result); }
      catch { if (!disposed) setError('状态暂时无法确认，请稍后查询。'); }
    };
    void query();
    const timer = setInterval(() => { void query(); }, 3000);
    window.addEventListener('focus', query);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', query); };
  }, [supported, request, snapshot.wait_id, accept]);
  const act = async (action: McpAuthorizationAction) => {
    if (!request || busy) return;
    // Open synchronously in the click gesture; do not infer consent from close.
    const opening = action === 'OpenMcpAuthorization' || action === 'RetryMcpAuthorization';
    const popup = opening ? window.open('about:blank', '_blank') : null;
    if (popup) popup.opener = null;
    setBusy(true); setError('');
    try {
      const result = await request(action, current.wait_id, current.revision);
      accept(result);
      if (opening && result.authorization_url) {
        const url = new URL(result.authorization_url);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('授权地址不受支持');
        if (popup) popup.location.href = url.href;
        else setError('浏览器拦截了授权窗口。请允许弹窗后再次点击打开授权。');
      }
    } catch (failure) { popup?.close(); setError(authorizationErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <section data-testid="mcp-authorization-card" className="rounded-xl border p-4 text-sm" aria-live="polite">
    <strong>MCP 服务授权 · {current.display_name || current.config_id}</strong>
    <p>{labels[current.status] || '等待服务端确认状态'}</p>
    <p>访问范围：{current.scopes.join('、')}</p>
    {current.error && <p>原因：{authorizationErrorMessage(current.error)}</p>}
    {!supported && <p role="alert">当前客户端或服务端不支持此授权协议，请升级后继续。</p>}
    {error && <p role="alert">{error}</p>}
    <div className="mt-2 flex flex-wrap gap-3">
      {current.allowed_actions.includes('open') && <button disabled={!supported || busy} onClick={() => void act('OpenMcpAuthorization')}>打开授权</button>}
      {current.allowed_actions.includes('retry_authorization') && current.status === 'authorization_failed' && <button disabled={!supported || busy} onClick={() => void act('RetryMcpAuthorization')}>重新授权</button>}
      {current.allowed_actions.includes('retry_connection') && <button disabled={!supported || busy} onClick={() => void act('RetryMcpConnection')}>重试连接</button>}
      <button disabled={!supported || busy} onClick={() => void act('GetMcpAuthorizationWait')}>查询状态</button>
      {current.allowed_actions.includes('cancel') && <button disabled={!supported || busy} onClick={() => void act('CancelMcpAuthorizationWait')}>取消任务</button>}
    </div>
  </section>;
}
