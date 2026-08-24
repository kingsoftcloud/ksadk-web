import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ThinkingMode } from '@/stores/model.js';

import type { ModelCatalogItem } from './types';

type SettingsPanel = 'model' | 'reasoning';

const reasoningOptions: Array<{
  value: ThinkingMode;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: '自动', description: '使用模型或 Agent 的默认设置' },
  { value: 'enabled', label: '开启', description: '请求模型输出推理过程' },
  { value: 'disabled', label: '关闭', description: '不额外请求模型推理' },
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
  const [panel, setPanel] = useState<SettingsPanel>('model');
  const ref = useRef<HTMLDivElement>(null);
  const selectedModelLabel =
    availableModels.find((model) => model.id === selectedModel)?.display_name
    || selectedModel
    || '选择模型';
  const activePanel: SettingsPanel = thinkingEnabled ? panel : 'model';

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
        className="flex h-8 max-w-[15rem] items-center gap-1.5 rounded-xl bg-muted/80 px-3 text-[13px] text-text-primary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
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
        <div className="absolute bottom-[calc(100%+0.65rem)] right-0 z-40 flex items-end gap-2 sm:flex-row-reverse">
          <div
            role="menu"
            aria-label={activePanel === 'model' ? '选择模型' : '选择推理设置'}
            className="max-h-[min(54vh,22rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border/80 bg-popover p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.16)]"
          >
            {thinkingEnabled ? (
              <div className="mb-1 grid grid-cols-2 gap-1 sm:hidden">
                <button
                  type="button"
                  onClick={() => setPanel('model')}
                  className={cn('rounded-lg px-2 py-1.5 text-xs', activePanel === 'model' ? 'bg-muted text-text-primary' : 'text-text-muted')}
                >
                  模型
                </button>
                <button
                  type="button"
                  onClick={() => setPanel('reasoning')}
                  className={cn('rounded-lg px-2 py-1.5 text-xs', activePanel === 'reasoning' ? 'bg-muted text-text-primary' : 'text-text-muted')}
                >
                  推理
                </button>
              </div>
            ) : null}
            <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-text-muted">
              {activePanel === 'model' ? '模型' : '推理设置'}
            </div>
            {activePanel === 'model' ? availableModels.map((model) => {
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
                    selected ? 'bg-muted text-text-primary' : 'text-text-secondary hover:bg-muted/70 hover:text-text-primary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{model.display_name || model.id}</span>
                  {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              );
            }) : reasoningOptions.map((option) => {
              const selected = option.value === thinkingMode;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectThinkingMode(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                    selected ? 'bg-muted' : 'hover:bg-muted/70',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-text-primary">{option.label}</span>
                    <span className="block text-[11px] leading-4 text-text-muted">{option.description}</span>
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          <div className="hidden w-[16rem] rounded-2xl border border-border/80 bg-popover p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.13)] sm:block">
            <button
              type="button"
              onClick={() => setPanel('model')}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-left text-[13px] transition-colors',
                activePanel === 'model' ? 'bg-muted text-text-primary' : 'text-text-secondary hover:bg-muted/70',
              )}
            >
              <span className="font-medium">模型</span>
              <span className="min-w-0 flex-1 truncate text-right text-text-muted">{selectedModelLabel}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
            </button>
            {thinkingEnabled ? (
              <button
                type="button"
                onClick={() => setPanel('reasoning')}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-left text-[13px] transition-colors',
                  activePanel === 'reasoning' ? 'bg-muted text-text-primary' : 'text-text-secondary hover:bg-muted/70',
                )}
              >
                <span className="font-medium">推理</span>
                <span className="min-w-0 flex-1 truncate text-right text-text-muted">{reasoningLabels[thinkingMode]}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
