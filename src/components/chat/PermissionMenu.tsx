import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Hand, ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePermissionStore } from '@/stores/permission.js';
import type { PermissionMode } from '@/core/run/types.js';
import type { ApprovalPolicyCapability } from '@/types/capabilities.js';

type PermissionOption = {
  value: PermissionMode;
  label: string;
  description: string;
  icon: typeof Hand;
};

const options: PermissionOption[] = [
  {
    value: 'ask',
    label: '请求批准',
    description: '有副作用的操作执行前先确认',
    icon: Hand,
  },
  {
    value: 'risk',
    label: '风险操作需确认',
    description: '只对命令、写入和外部副作用确认',
    icon: ShieldCheck,
  },
  {
    value: 'full',
    label: '完全访问',
    description: '本次会话不再为默认规则弹出确认',
    icon: ShieldAlert,
  },
];

const triggerLabels: Record<PermissionMode, string> = {
  ask: '请求批准',
  risk: '风险确认',
  full: '完全访问',
};

type PermissionMenuProps = {
  approvalPolicy?: ApprovalPolicyCapability;
};

export function PermissionMenu({ approvalPolicy }: PermissionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const permissionMode = usePermissionStore((state) => state.permissionMode);
  const setPermissionMode = usePermissionStore((state) => state.setPermissionMode);
  const visibleOptions = options.filter(
    (option) => !approvalPolicy || approvalPolicy.Modes.includes(option.value),
  );

  useEffect(() => {
    if (visibleOptions.some((option) => option.value === permissionMode)) return;
    setPermissionMode(approvalPolicy?.DefaultMode || visibleOptions[0]?.value || 'risk');
  }, [approvalPolicy?.DefaultMode, permissionMode, setPermissionMode, visibleOptions]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
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
        className="flex h-8 items-center gap-1 rounded-full px-2 text-[13px] text-text-secondary transition hover:bg-muted hover:text-text-primary"
        aria-expanded={open}
        aria-haspopup="menu"
        title="设置本次会话的工具审批规则"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>{triggerLabels[permissionMode]}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="工具权限"
          className="absolute bottom-[calc(100%+0.6rem)] left-0 z-30 w-[19rem] rounded-2xl border border-border/80 bg-popover p-1.5 shadow-[0_12px_30px_rgba(15,23,42,0.14)]"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] text-text-muted">本次会话的默认审批规则</div>
          {visibleOptions.map((option) => {
            const Icon = option.icon;
            const selected = option.value === permissionMode;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setPermissionMode(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
                  selected ? 'bg-primary/[0.08]' : 'hover:bg-muted/75',
                )}
              >
                <Icon className={cn('h-[17px] w-[17px] shrink-0', selected ? 'text-primary' : 'text-text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-[13px] font-medium leading-5', selected ? 'text-text-primary' : 'text-text-secondary')}>
                    {option.label}
                  </span>
                  <span className="block text-[11px] leading-4 text-text-muted">{option.description}</span>
                </span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
