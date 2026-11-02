import { cn } from '../../lib/utils.js';

export function RunProgressIndicator({ label }: { label: string }) {
  const waitingForInput = label === '等待你的确认…';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-progress-indicator"
      className="mx-auto flex w-full max-w-[60rem] items-center gap-2 px-2 py-1 text-[13px] text-text-muted sm:px-4"
    >
      <span aria-hidden="true" className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
        !waitingForInput && 'motion-safe:animate-pulse',
      )} />
      <span className={cn(!waitingForInput && 'waiting-thinking-text')}>{label}</span>
    </div>
  );
}
