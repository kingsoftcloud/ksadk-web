import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ComposerContextIndicator } from './types';

type ContextUsageIndicatorProps = {
  indicator: Exclude<ComposerContextIndicator, null>;
  onCompact?: () => Promise<void>;
  disabled?: boolean;
};

export function ContextUsageIndicator({ indicator, onCompact, disabled }: ContextUsageIndicatorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        rootRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [open]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const percent = Math.max(0, Math.min(100, indicator.percent ?? 0));
  const compact = async () => {
    if (!onCompact || busy || disabled) return;
    setBusy(true);
    setResult('');
    try {
      await onCompact();
      setResult('上下文已压缩');
    } catch (error) {
      setResult(error instanceof Error ? error.message : '压缩失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={rootRef} className="relative flex h-8 w-8 items-center justify-center">
      <button type="button" aria-label="上下文用量与压缩" aria-expanded={open}
        onClick={() => { setOpen(!open); setResult(''); }}
        className={cn('flex h-8 w-8 items-center justify-center rounded-full',
          indicator.phase === 'warning' ? 'text-text-primary' : 'text-text-muted')}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
          className={busy ? 'animate-pulse' : undefined} style={{ display: 'block', flexShrink: 0 }}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--ksadk-menu-border, #b8bcb5)" strokeWidth="2" />
          {indicator.percent !== undefined && <circle cx="8" cy="8" r="6" fill="none"
            stroke="currentColor" strokeWidth="2" pathLength="100"
            strokeDasharray={`${percent} 100`} transform="rotate(-90 8 8)" />}
        </svg>
      </button>
      <div style={{
        background: 'var(--ksadk-menu-background, hsl(var(--popover)))',
        borderColor: 'var(--ksadk-menu-border, hsl(var(--border)))',
        boxShadow: 'var(--ksadk-menu-shadow, 0 18px 44px rgba(15, 23, 42, 0.16))',
      }} role={open ? 'dialog' : undefined} aria-label={open ? '上下文' : undefined}
        className={cn('absolute bottom-full right-0 z-30 w-60 rounded-xl border border-border bg-background p-4 text-sm text-foreground shadow-lg',
          open ? 'block' : 'hidden')}>
        <p className={cn("font-medium", busy && "waiting-thinking-text")}>{busy ? '正在压缩上下文…' : indicator.label}</p>
        <p className="mt-1 text-text-secondary">
          {indicator.usedTokens !== undefined ? `${formatTokens(indicator.usedTokens)} tokens` : '等待运行时报告用量'}
          {indicator.contextWindowTokens ? ` / ${formatTokens(indicator.contextWindowTokens)}` : ''}
        </p>
        {indicator.usedTokens !== undefined && !indicator.contextWindowTokens && <p className="mt-1 text-text-muted">模型窗口大小未报告</p>}
        {indicator.percent !== undefined && <p className="text-text-muted">{indicator.percent}% 已使用</p>}
        {open && <>
          <button type="button" onClick={() => void compact()} disabled={!onCompact || busy || disabled}
            className="mt-3 w-full rounded-lg border border-border bg-muted px-3 py-2 disabled:opacity-50">
            {busy ? '正在压缩…' : '压缩上下文'}
          </button>
          <p className="mt-2 text-xs text-text-muted">{disabled ? '请等待当前运行结束' : !onCompact ? '当前会话尚不支持手动压缩' : '压缩模型上下文，保留聊天记录'}</p>
          {result && <p role="status" className="mt-2 text-xs">{result}</p>}
        </>}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}
