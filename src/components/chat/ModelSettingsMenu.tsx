import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ThinkingMode } from '@/stores/model.js';

import type { ModelCatalogItem } from './types';

const reasoningOptions: Array<{ value: ThinkingMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'enabled', label: '开启' },
  { value: 'disabled', label: '关闭' },
];

const reasoningLabels: Record<ThinkingMode, string> = {
  auto: '自动',
  enabled: '开启',
  disabled: '关闭',
};

type ModelSettingsMenuProps = {
  availableModels: ModelCatalogItem[];
  selectedModel: string;
  thinkingEnabled: boolean;
  thinkingMode: ThinkingMode;
  onSelectModel: (modelId: string) => void;
  onSelectThinkingMode: (mode: ThinkingMode) => void;
};

export function ModelSettingsMenu({
  availableModels,
  selectedModel,
  thinkingEnabled,
  thinkingMode,
  onSelectModel,
  onSelectThinkingMode,
}: ModelSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedModelLabel =
    availableModels.find((model) => model.id === selectedModel)?.display_name
    || selectedModel
    || '选择模型';

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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 max-w-[15rem] items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-primary transition hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        style={{ background: 'var(--ksadk-menu-trigger-background, hsl(var(--muted)))' }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={thinkingEnabled
          ? `模型 ${selectedModelLabel}，推理 ${reasoningLabels[thinkingMode]}`
          : `模型 ${selectedModelLabel}`}
        title={thinkingEnabled ? '选择模型与推理设置' : '选择模型'}
      >
        <span className="min-w-0 truncate">{selectedModelLabel}</span>
        {thinkingEnabled ? (
          <span className="shrink-0 text-text-muted">{reasoningLabels[thinkingMode]}</span>
        ) : null}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="选择模型"
          className="absolute bottom-[calc(100%+0.65rem)] right-0 z-40 w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border p-1.5"
          style={{
            background: 'var(--ksadk-menu-background, hsl(var(--popover)))',
            borderColor: 'var(--ksadk-menu-border, hsl(var(--border)))',
            boxShadow: 'var(--ksadk-menu-shadow, 0 18px 44px rgba(15, 23, 42, 0.16))',
          }}
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-text-muted">模型</div>
          <div className="max-h-[min(45vh,18rem)] overflow-y-auto">
            {availableModels.map((model) => {
              const selected = model.id === selectedModel;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectModel(model.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors',
                    selected ? 'bg-muted text-text-primary' : 'text-text-secondary hover:bg-muted hover:text-text-primary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{model.display_name || model.id}</span>
                  {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          {thinkingEnabled ? (
            <div className="mt-1 border-t border-border px-1 pt-1.5">
              <div className="flex items-center justify-between gap-2 px-1.5 pb-1">
                <span className="text-[11px] font-medium text-text-muted">推理</span>
                <div className="flex rounded-lg bg-muted p-0.5">
                  {reasoningOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onSelectThinkingMode(option.value)}
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition-colors',
                        option.value === thinkingMode
                          ? 'bg-card text-text-primary shadow-sm'
                          : 'text-text-muted hover:text-text-primary',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
