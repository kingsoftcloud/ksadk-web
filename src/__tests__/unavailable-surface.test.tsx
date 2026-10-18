import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnavailableSurfaceNotice } from '../components/UnavailableSurfaceNotice';

describe('unavailable direct surface', () => {
  it.each([['tui', '终端'], ['workspace', '工作区']] as const)('explains disabled %s', (surface, label) => {
    const html = renderToStaticMarkup(<UnavailableSurfaceNotice surface={surface} terminalEnabled={false} workspaceEnabled={false} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(`当前 Agent 未开放${label}。`);
  });
  it.each(['chat', 'tui', 'workspace'] as const)('does not mask an available %s', surface => {
    expect(renderToStaticMarkup(<UnavailableSurfaceNotice surface={surface} terminalEnabled workspaceEnabled />)).toBe('');
  });
});
