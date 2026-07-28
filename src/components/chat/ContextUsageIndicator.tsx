import type { ComposerContextIndicator } from './types';

type NonNullIndicator = Exclude<ComposerContextIndicator, null>;

/**
 * wework 风格上下文长度圆环指示器。
 * 形态:h-4 w-4 圆环,conic-gradient 按 usedPercent 填充,中心挖空 bg-background。
 * usedPercent>=85(警告阈值)转 red-500。hover 浮 tooltip 卡显示百分比/token。
 */
type ContextUsageIndicatorProps = {
  indicator: NonNullIndicator;
};

export function ContextUsageIndicator({ indicator }: ContextUsageIndicatorProps) {
  const percent = Math.max(0, Math.min(100, indicator.percent ?? 0));
  const warning = indicator.phase === 'warning' || indicator.phase === 'compressing' || percent >= 85;
  const ringColor = warning ? '#ef4444' : '#a5abb2';
  const trackColor = '#edf0f2';

  return (
    <div className="group relative flex h-8 w-8 items-center justify-center">
      <div
        className="h-4 w-4 rounded-full"
        style={{
          background: `conic-gradient(${ringColor} ${percent * 3.6}deg, ${trackColor} 0deg)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title={indicator.label}
      >
        <div className="h-2 w-2 rounded-full bg-background" />
      </div>
      {/* hover tooltip:wework rounded-2xl 卡 */}
      <div className="pointer-events-auto absolute bottom-[calc(100%+0.5rem)] left-1/2 z-30 hidden w-max -translate-x-1/2 rounded-2xl border border-border/70 bg-background px-4 py-3 text-center text-sm leading-5 text-foreground shadow-[0_14px_42px_rgba(15,23,42,0.16)] group-hover:block dark:shadow-[0_14px_42px_rgba(0,0,0,0.4)]">
        <div className="font-medium">估算上下文</div>
        <div className="mt-0.5 text-text-secondary">{indicator.label}</div>
      </div>
    </div>
  );
}
