import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf-8',
  );
}

describe('Native terminal panel bundle boundaries', () => {
  it('keeps the terminal panel behind lazy imports', () => {
    const chatHeader = readSource('components/chat/ChatHeader.tsx');
    const nativeLauncher = readSource('components/native/NativeRuntimeLauncher.tsx');

    expect(chatHeader).toContain("import('@/components/native/NativeTerminalPanel')");
    expect(nativeLauncher).toContain("import('./NativeTerminalPanel')");
    expect(chatHeader).not.toContain("import { NativeTerminalPanel }");
    expect(nativeLauncher).not.toContain("import { NativeTerminalPanel }");
  });

  it('renders the terminal panel as a fullscreen-only surface', () => {
    const terminalPanel = readSource('components/native/NativeTerminalPanel.tsx');

    expect(terminalPanel).toContain('fixed inset-0');
    expect(terminalPanel).toContain('ResizeObserver');
    expect(terminalPanel).not.toContain('setFullscreen');
    expect(terminalPanel).not.toContain('aria-label={fullscreen');
  });

  it('keeps remote TUI sessions alive and filters terminal color responses', () => {
    const terminalPanel = readSource('components/native/NativeTerminalPanel.tsx');

    expect(terminalPanel).toContain('sanitizeTerminalInputForPty');
    expect(terminalPanel).toContain("type: 'ping'");
    expect(terminalPanel).toContain('TERMINAL_KEEPALIVE_INTERVAL_MS');
  });

  it('forwards xterm binary mouse reports for hosted TUI scrolling', () => {
    const terminalPanel = readSource('components/native/NativeTerminalPanel.tsx');

    expect(terminalPanel).toContain('binaryDisposable');
    expect(terminalPanel).toContain('terminal.onBinary');
    expect(terminalPanel).toContain('sendPtyInput(data)');
  });

  it('lists first, reuses existing TUI sessions, and only force-creates on explicit new', () => {
    const terminalPanel = readSource('components/native/NativeTerminalPanel.tsx');

    expect(terminalPanel).toContain('autoCreateWhenEmpty?: boolean');
    expect(terminalPanel).toContain('autoCreateWhenEmpty = true');
    expect(terminalPanel).toContain('const refreshSessionsRef = useRef<(() => Promise<void>) | null>(null)');
    expect(terminalPanel).toContain('const autoCreateAttemptedRef = useRef(false)');
    expect(terminalPanel).toContain('buildCreateTerminalSessionPayload({ mode: capability.Mode || \'tui\', forceNew })');
    expect(terminalPanel).toContain('return normalized[0]?.terminal_session_id || null');
    expect(terminalPanel).toContain('normalized.length === 0');
    expect(terminalPanel).toContain('!autoCreateAttemptedRef.current');
    expect(terminalPanel).toContain('await createTerminalSession()');
    expect(terminalPanel).toContain('createTerminalSession({ forceNew: true })');
  });

  it('does not retry auto-create loops after close or failed creation', () => {
    const terminalPanel = readSource('components/native/NativeTerminalPanel.tsx');

    expect(terminalPanel).toContain('autoCreateAttemptedRef.current = true');
    expect(terminalPanel).toContain('if (!open || !capability.Enabled) {');
    expect(terminalPanel).toContain('autoCreateAttemptedRef.current = false');
    expect(terminalPanel).toContain('if (!response.ok) {');
    expect(terminalPanel).toContain("setStatus('error')");
  });

  it('exposes hosted route surfaces through AgentWorkbench', () => {
    const app = readSource('App.tsx');
    const runtime = readSource('public/runtime.ts');

    expect(app).toContain("export type AgentWorkbenchInitialSurface = 'chat' | 'tui' | 'workspace'");
    expect(app).toContain('initialSurface?: AgentWorkbenchInitialSurface');
    expect(app).toContain("initialSurface = 'chat'");
    expect(app).toContain("initialSurface !== 'workspace'");
    expect(app).toContain('setWorkspacePanelOpen(true)');
    expect(app).toContain('setWorkspacePanelFullscreen(true)');
    expect(app).toContain("initialSurface === 'tui'");
    expect(app).toContain('LazyNativeTerminalPanel');
    expect(runtime).toContain('AgentWorkbenchProps');
  });
});
