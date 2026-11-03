import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useBootstrapStore } from '@/stores/bootstrap.js';
import {
  EXECUTION_PERMISSION_DESCRIPTIONS,
  EXECUTION_PERMISSION_LABELS,
  EXECUTION_PERMISSION_TRIGGERS,
  normalizeExecutionModes,
  useExecutionPermissionStore,
} from '@/stores/execution-permission.js';
import type { ExecutionPermissionMode, ExecutionPolicyCapability } from '@/types/capabilities.js';

const icons: Record<ExecutionPermissionMode, typeof Eye> = {
  'read-only': Eye,
  'workspace-write': ShieldCheck,
  'danger-full-access': ShieldAlert,
};

type ExecutionPermissionMenuProps = {
  executionPolicy?: ExecutionPolicyCapability | null;
};

/**
 * The single permission selector of the Hosted UI: how much the runtime may
 * touch. The approval policy is fixed by the deployment and is not user-facing.
 */
export function ExecutionPermissionMenu({ executionPolicy }: ExecutionPermissionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const agentId = useBootstrapStore((state) => state.agentId);
  const byAgent = useExecutionPermissionStore((state) => state.byAgent);
  const configure = useExecutionPermissionStore((state) => state.configure);
  const select = useExecutionPermissionStore((state) => state.select);
  const modes = useMemo(() => normalizeExecutionModes(executionPolicy), [executionPolicy]);
  const mode = byAgent[agentId] ?? modes[0];

  useEffect(() => {
    if (agentId && modes.length > 0) configure(agentId, executionPolicy);
  }, [agentId, configure, executionPolicy, modes.length]);

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

  if (modes.length === 0 || !mode) return null;
  const TriggerIcon = icons[mode];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[13px] transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
          mode === 'danger-full-access'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-text-secondary hover:text-text-primary',
        )}
        aria-expanded={open}
        aria-haspopup="menu"
        title="设置本次会话的执行权限"
      >
        <TriggerIcon className="h-3.5 w-3.5" />
        <span>{EXECUTION_PERMISSION_TRIGGERS[mode]}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="执行权限"
          className="absolute bottom-[calc(100%+0.6rem)] left-0 z-30 w-[18rem] rounded-xl border border-border/80 bg-popover p-1 shadow-[0_10px_24px_rgba(15,23,42,0.12)]"
          style={{
            backgroundColor: 'var(--ksadk-popover, #fff)',
            borderColor: 'var(--ksadk-border, rgba(15, 23, 42, 0.12))',
          }}
        >
          {modes.map((candidate) => {
            const Icon = icons[candidate];
            const selected = candidate === mode;
            return (
              <button
                key={candidate}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  if (agentId) select(agentId, candidate);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors',
                  selected ? 'bg-primary/[0.08]' : 'hover:bg-muted/75',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', selected ? 'text-primary' : 'text-text-muted')} />
                <span className={cn('shrink-0 text-[13px] font-medium', selected ? 'text-text-primary' : 'text-text-secondary')}>
                  {EXECUTION_PERMISSION_LABELS[candidate]}
                </span>
                <span className="ml-auto truncate text-[11px] text-text-muted">{EXECUTION_PERMISSION_DESCRIPTIONS[candidate]}</span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
