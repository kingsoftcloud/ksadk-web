import { useEffect, useState } from 'react';

import { LoaderCircle, RefreshCw, WifiOff, ZapOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useStreamingStore } from '@/stores/streaming.js';

/**
 * wework 风格错误/限流/重连内联状态条。
 * 从 streaming store 的 banner 字段驱动,内联在消息区底部(不白屏)。
 * - rate_limited:友好提示"请求过于频繁",带 Retry-After 倒计时(若有)
 * - network:网络异常重连中(spinner)
 * - error:运行失败 + 重试按钮
 */
type StatusBannerProps = {
  onRetry?: () => void;
};

export function StatusBanner({ onRetry }: StatusBannerProps) {
  const banner = useStreamingStore((s) => s.banner);
  if (!banner) return null;

  const rateLimitedLabel = banner.kind === 'rate_limited' ? (
    <RateLimitLabel
      key={banner.createdAt || `${banner.sessionId || ''}:${banner.retryAfterSec || 0}`}
      message={banner.message}
      retryAfterSec={banner.retryAfterSec}
    />
  ) : null;

  const config = {
    rate_limited: {
      icon: <ZapOff className="h-4 w-4 text-amber-500" />,
      bg: 'border-amber-200/70 bg-amber-50/70 dark:border-amber-900/40 dark:bg-amber-950/20',
      text: 'text-amber-700 dark:text-amber-200',
      label: rateLimitedLabel,
    },
    network: {
      icon: <LoaderCircle className="h-4 w-4 animate-spin text-text-secondary" />,
      bg: 'border-border/70 bg-muted/60',
      text: 'text-text-secondary',
      label: banner.message || '网络异常，正在重连…',
    },
    error: {
      icon: <WifiOff className="h-4 w-4 text-rose-500" />,
      bg: 'border-rose-200/70 bg-rose-50/70 dark:border-rose-900/40 dark:bg-rose-950/20',
      text: 'text-rose-600 dark:text-rose-300',
      label: banner.message || '运行失败，请重试',
    },
  }[banner.kind];

  return (
    <div
      className={cn(
        'mx-auto mb-3 flex w-full max-w-3xl items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-sm',
        config.bg,
        config.text,
      )}
      role="status"
    >
      {config.icon}
      <span className="min-w-0 flex-1 truncate">{config.label}</span>
      {banner.kind === 'error' && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/40"
        >
          <RefreshCw className="h-3 w-3" />
          重试
        </button>
      ) : null}
    </div>
  );
}

function RateLimitLabel({ message, retryAfterSec }: { message: string; retryAfterSec?: number }) {
  const [remaining, setRemaining] = useState(retryAfterSec || 0);

  useEffect(() => {
    if (!retryAfterSec) return undefined;
    const timer = setInterval(() => {
      setRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfterSec]);

  return remaining > 0 ? `${message}（${remaining}s 后可重试）` : message;
}
