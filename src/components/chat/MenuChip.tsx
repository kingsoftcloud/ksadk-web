import { useEffect, useRef, useState } from 'react';

import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * wework 风格自定义下拉 chip:点击触发器(label+chevron)弹 rounded-xl 卡片菜单,
 * 选项 hover bg-muted,选中高亮。替代原生 select(原生箭头/样式不可控)。
 */
type Option = {
  value: string;
  label: string;
};

type MenuChipProps = {
  /** 触发器显示的当前 label。 */
  label: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
};

export function MenuChip({ label, options, value, onChange, title }: MenuChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={title}
        className="flex h-8 max-w-[12rem] items-center gap-1 rounded-full px-2 text-sm leading-[18px] text-text-secondary transition-colors hover:bg-muted"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 flex-shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 max-h-[min(50vh,20rem)] min-w-[10rem] max-w-[16rem] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-sm shadow-[0_10px_28px_rgba(0,0,0,0.18)]">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center rounded-lg px-2.5 py-1.5 text-left leading-5 transition-colors',
                option.value === value
                  ? 'bg-muted text-text-primary'
                  : 'text-text-secondary hover:bg-muted hover:text-text-primary',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
