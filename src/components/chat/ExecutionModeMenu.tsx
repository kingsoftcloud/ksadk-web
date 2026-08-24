import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown, ListTodo, Plus, Target, Upload } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { RuntimeExecutionMode } from '@/core/run/types.js';

export type RuntimeExecutionModeSupport = Record<RuntimeExecutionMode, boolean>;

type ExecutionModeMenuProps = {
  attachmentsEnabled: boolean;
  mode?: RuntimeExecutionMode;
  support: RuntimeExecutionModeSupport;
  onSelectMode: (mode: RuntimeExecutionMode) => void;
  onUpload: () => void;
};

const modeOptions: Array<{
  value: RuntimeExecutionMode;
  label: string;
  description: string;
  icon: typeof ListTodo;
}> = [
  { value: 'plan', label: '计划模式', description: '先分析并形成可执行计划', icon: ListTodo },
  { value: 'goal', label: '设定目标', description: '朝可验证的停止条件持续推进', icon: Target },
];

const modeLabels: Record<RuntimeExecutionMode, string> = {
  plan: '计划模式',
  goal: '目标',
};

export function ExecutionModeMenu({
  attachmentsEnabled,
  mode,
  support,
  onSelectMode,
  onUpload,
}: ExecutionModeMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibleModes = modeOptions.filter((option) => support[option.value]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (!attachmentsEnabled && visibleModes.length === 0) return null;

  return (
    <div ref={ref} className="relative flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary transition hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="添加附件或选择执行模式"
        title="添加附件或选择执行模式"
      >
        <Plus className="h-[19px] w-[19px]" />
      </button>

      {mode ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'flex h-8 max-w-[8.5rem] items-center gap-1 rounded-xl px-2 text-[12px] transition',
            mode === 'goal'
              ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300'
              : 'text-text-secondary hover:bg-muted hover:text-text-primary',
          )}
          aria-label={`当前执行模式：${modeLabels[mode]}`}
        >
          <span className="truncate">{modeLabels[mode]}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      ) : null}

      {open ? (
        <div
          role="menu"
          aria-label="附件与执行模式"
          className="absolute bottom-[calc(100%+0.65rem)] left-0 z-40 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border/80 bg-popover p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.16)]"
        >
          {attachmentsEnabled ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onUpload();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-muted/70"
            >
              <Upload className="h-4 w-4 shrink-0 text-text-muted" />
              <span>
                <span className="block text-[13px] font-medium text-text-primary">上传附件</span>
                <span className="block text-[11px] text-text-muted">添加文件或图片到当前消息</span>
              </span>
            </button>
          ) : null}

          {attachmentsEnabled && visibleModes.length > 0 ? <div className="my-1 h-px bg-border/70" /> : null}

          {visibleModes.map((option) => {
            const Icon = option.icon;
            const selected = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onSelectMode(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition',
                  selected ? 'bg-muted' : 'hover:bg-muted/70',
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-text-primary">{option.label}</span>
                  <span className="block text-[11px] text-text-muted">{option.description}</span>
                </span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
