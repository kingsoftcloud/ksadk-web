import { cn } from '@/lib/utils';
import type { ComposerContextIndicator } from './types';

type NonNullIndicator = Exclude<ComposerContextIndicator, null>;

/**
 * wework 风格上下文长度圆环指示器。
 * 形态:h-4 w-4 圆环,conic-gradient(currentColor) 按 usedPercent 填充,中心挖空 bg-background。
 * usedPercent>=85(警告阈值)转 red-500。hover 浮 tooltip 卡显示百分比/token(k/m 缩写)。
 */
type ContextUsageIndicatorProps = {
  indicator: NonNullIndicator;
};

export function ContextUsageIndicator({ indicator }: ContextUsageIndicatorProps) {
  const percent = Math.max(0, Math.min(100, indicator.percent ?? 0));
  const warning = indicator.phase === 'warning' || indicator.phase === 'compressing' || percent >= 85;

  return (
    <div className="group relative flex h-8 w-8 items-center justify-center">
      <div
        className={cn('flex h-4 w-4 items-center justify-center rounded-full', warning ? 'text-red-500' : 'text-[#a5abb2]')}
        title={indicator.label}
      >
        <div
          className="flex h-3 w-3 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(currentColor ${percent * 3.6}deg, #edf0f2 0deg)` }}
        >
          <span className="h-2 w-2 rounded-full bg-background" />
        </div>
      </div>
      {/* hover tooltip:wework rounded-2xl 卡,三行 font-light */}
      <div className="pointer-events-auto absolute bottom-[calc(100%+0.75rem)] left-1/2 z-30 hidden w-max -translate-x-1/2 rounded-2xl border border-border/70 bg-background px-4 py-3 text-center text-sm leading-5 text-foreground shadow-[0_14px_42px_rgba(15,23,42,0.16)] group-hover:block dark:shadow-[0_14px_42px_rgba(0,0,0,0.4)]">
        <div className="mb-1 whitespace-nowrap font-light text-text-secondary">估算上下文</div>
        <div className="whitespace-nowrap font-light">{percent}% 已使用</div>
        <div className="whitespace-nowrap font-light text-text-muted">
          {indicator.usedTokens && indicator.contextWindowTokens
            ? `${formatTokens(indicator.usedTokens)} / ${formatTokens(indicator.contextWindowTokens)}`
            : indicator.label}
        </div>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}
