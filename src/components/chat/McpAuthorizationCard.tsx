import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/button.js';
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
// eslint-disable-next-line react-refresh/only-export-components -- Also used by authorization consumers to sanitize provider errors.
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
  return <div className="custom-scrollbar mx-auto mb-2 min-h-0 max-h-[min(60dvh,36rem)] w-full max-w-[64rem] overflow-y-auto overscroll-contain px-3 sm:px-4">
    <section data-testid="mcp-authorization-card" aria-label="MCP 服务授权" aria-live="polite"
      className="rounded-2xl border border-[var(--ksadk-interaction-border,hsl(var(--border)))] bg-[var(--ksadk-interaction-background,hsl(var(--card)))] px-4 py-5 text-center text-sm text-[var(--ksadk-interaction-foreground,hsl(var(--foreground)))] shadow-sm sm:px-6 sm:py-6">
      <div className="mx-auto flex min-w-0 max-w-xl flex-col items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ksadk-interaction-muted-background,hsl(var(--muted)))]">
          <ShieldCheck className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
        </div>
        <div className="w-full min-w-0 space-y-1.5">
          <h3 className="break-words text-base font-semibold leading-6">MCP 服务授权 · {current.display_name || current.config_id}</h3>
          <p className="break-words leading-5 text-[var(--ksadk-interaction-muted,hsl(var(--muted-foreground)))]">{labels[current.status] || '等待服务端确认状态'}</p>
        </div>
        {current.scopes.length > 0 && <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-1.5 text-xs leading-5">
          <span className="text-[var(--ksadk-interaction-muted,hsl(var(--muted-foreground)))]">访问范围：</span>
          {current.scopes.map(scope => <span key={scope} className="max-w-full break-all rounded-md bg-[var(--ksadk-interaction-muted-background,hsl(var(--muted)))] px-2 py-0.5">{scope}</span>)}
        </div>}
        {current.error && <p className="w-full break-words leading-5 text-rose-600 dark:text-rose-400">原因：{authorizationErrorMessage(current.error)}</p>}
        {!supported && <p role="alert" className="w-full break-words leading-5 text-rose-600 dark:text-rose-400">当前客户端或服务端不支持此授权协议，请升级后继续。</p>}
        {error && <p role="alert" className="w-full break-words leading-5 text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-1 flex w-full flex-wrap items-center justify-center gap-2">
          {current.allowed_actions.includes('open') && <Button type="button" size="sm" disabled={!supported || busy} onClick={() => void act('OpenMcpAuthorization')}>
            <ExternalLink aria-hidden="true" />打开授权
          </Button>}
          {current.allowed_actions.includes('retry_authorization') && current.status === 'authorization_failed' && <Button type="button" size="sm" disabled={!supported || busy} onClick={() => void act('RetryMcpAuthorization')}>重新授权</Button>}
          {current.allowed_actions.includes('retry_connection') && <Button type="button" size="sm" disabled={!supported || busy} onClick={() => void act('RetryMcpConnection')}>重试连接</Button>}
          <Button type="button" size="sm" variant="outline" disabled={!supported || busy} onClick={() => void act('GetMcpAuthorizationWait')}>查询状态</Button>
          {current.allowed_actions.includes('cancel') && <Button type="button" size="sm" variant="ghost" disabled={!supported || busy} onClick={() => void act('CancelMcpAuthorizationWait')}>取消任务</Button>}
        </div>
      </div>
    </section>
  </div>;
}
