export function UnavailableSurfaceNotice({ surface, terminalEnabled, workspaceEnabled }: {
  surface: 'chat' | 'tui' | 'workspace';
  terminalEnabled: boolean;
  workspaceEnabled: boolean;
}) {
  const label = surface === 'tui' && !terminalEnabled ? '终端'
    : surface === 'workspace' && !workspaceEnabled ? '工作区' : null;
  return label ? <p role="status" className="px-6 py-3 text-sm text-text-secondary">当前 Agent 未开放{label}。</p> : null;
}
