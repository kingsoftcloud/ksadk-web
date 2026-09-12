/** Approval payloads are untrusted text; only a recognized argument envelope gets a structured view. */
type ArgumentEnvelope = { arguments: Record<string, unknown>; risk?: unknown };
export function InteractionMessage({ message }: { message: string }) {
  let details: ArgumentEnvelope | null = null;
  try {
    const value: unknown = JSON.parse(message);
    if (value && typeof value === 'object' && 'arguments' in value && value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)) details = value as ArgumentEnvelope;
  } catch { /* Plain descriptions remain plain descriptions. */ }
  if (!details) return <p>{message}</p>;
  const labels: Record<string, string> = { path: '文件位置', command: '命令', cwd: '执行目录' };
  const risks: Record<string, string> = { low: '低', medium: '中', high: '高' };
  const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <div className="team-approval-details">
    <dl>{Object.entries(details.arguments).filter(([name]) => name !== 'content').map(([name, value]) => <div key={name}><dt>{labels[name] || name}</dt><dd><code>{display(value)}</code></dd></div>)}</dl>
    {'content' in details.arguments && <details className="team-approval-preview"><summary>查看待写入的文件内容</summary><pre>{display(details.arguments.content)}</pre></details>}
    {typeof details.risk === 'string' && <p className="team-approval-risk">风险级别：{risks[details.risk] || details.risk}</p>}
  </div>;
}
