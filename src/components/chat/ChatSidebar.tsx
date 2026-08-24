import { useMemo, useState, type MouseEvent, type UIEvent } from 'react';

import { LoaderCircle, MessageSquarePlus, Pin, PinOff, Search, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  normalizeSidebarSessions,
  resolveCompactSessionMeta,
} from '@/utils/session-list.js';

import type { Session } from './types';

type ChatSidebarProps = {
  sessions: Session[];
  currentSessionId: string | null;
  onCreateNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onTogglePinSession: (sessionId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onLoadMoreSessions?: () => void;
  sessionTitle: (session: Session) => string;
  pinnedSessionIds?: string[];
  hasMoreSessions?: boolean;
  isLoadingSessions?: boolean;
  className?: string;
};

export function ChatSidebar({
  sessions,
  currentSessionId,
  onCreateNewSession,
  onSelectSession,
  onDeleteSession,
  onTogglePinSession,
  onLoadMoreSessions,
  sessionTitle,
  pinnedSessionIds = [],
  hasMoreSessions = false,
  isLoadingSessions = false,
  className,
}: ChatSidebarProps) {
  const [query, setQuery] = useState('');
  const visibleSessions = useMemo(
    () => normalizeSidebarSessions(sessions, query, { pinnedSessionIds }),
    [sessions, pinnedSessionIds, query],
  );
  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!onLoadMoreSessions || isLoadingSessions || !hasMoreSessions || query.trim()) {
      return;
    }
    const target = event.currentTarget;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom < 200) {
      onLoadMoreSessions();
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-sidebar', className)}>
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-black/[0.06] px-3 py-3 dark:border-white/[0.08]">
        <button
          type="button"
          onClick={onCreateNewSession}
          className="flex h-[34px] w-full items-center justify-between rounded-[10px] px-2.5 text-sm font-medium text-sidebar-text-secondary transition-colors hover:bg-sidebar-hover hover:text-sidebar-text"
        >
          <span className="flex items-center gap-1.5">
            <MessageSquarePlus className="h-4 w-4" />
            <span>新对话</span>
          </span>
          <span className="rounded border border-black/[0.08] px-1.5 py-0.5 text-[11px] text-sidebar-text-muted dark:border-white/[0.1]">
            ⌘ N
          </span>
        </button>
        <label className="flex h-9 items-center gap-2 rounded-[10px] border border-black/[0.06] bg-background px-2.5 text-xs text-sidebar-text-muted focus-within:border-primary/40 dark:border-white/[0.08]">
          <Search className="h-3.5 w-3.5 flex-shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-text outline-none placeholder:text-sidebar-text-muted"
            placeholder="搜索会话、模型或摘要"
          />
        </label>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 custom-scrollbar"
        onScroll={handleScroll}
      >
        <div className="px-2.5 py-2 text-xs font-medium text-sidebar-text-muted opacity-75">
          历史记录{query.trim() ? ` · ${visibleSessions.length}` : ''}
        </div>
        <div className="flex flex-col gap-0.5">
          {visibleSessions.length > 0 ? (
            visibleSessions.map((session) => {
              const meta = resolveCompactSessionMeta(session);
              const pinned = pinnedSet.has(session.SessionId);
              const selected = currentSessionId === session.SessionId;
              return (
                <div
                  key={session.SessionId}
                  className={cn(
                    'group relative flex h-[30px] items-center gap-1 rounded-[10px] border-l-2 border-transparent px-2 text-sm leading-5 transition-colors',
                    selected
                      ? 'border-l-2 border-primary bg-primary/10 font-medium text-sidebar-text'
                      : meta.running
                        ? 'cursor-pointer bg-primary/[0.035] text-sidebar-text'
                        : 'cursor-pointer text-sidebar-text-secondary hover:bg-sidebar-hover hover:text-sidebar-text',
                  )}
                >
                  <button
                    type="button"
                    aria-current={selected ? 'page' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    onClick={() => onSelectSession(session.SessionId)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {sessionTitle(session)}
                    </span>
                    {meta.running ? (
                      <span
                        aria-label="运行中"
                        className="h-1.5 w-1.5 flex-shrink-0 animate-spin rounded-full border border-primary border-t-transparent"
                      />
                    ) : meta.failed ? (
                      <span
                        aria-label="运行失败"
                        title="运行失败"
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-500/75"
                      />
                    ) : meta.label ? (
                      <span className="flex-shrink-0 text-[11px] leading-none text-sidebar-text-muted group-hover:hidden">
                        {meta.label}
                      </span>
                    ) : null}
                  </button>
                  <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => onTogglePinSession(session.SessionId, event)}
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-md text-sidebar-text-muted hover:bg-sidebar-active hover:text-sidebar-text',
                        pinned && 'text-primary opacity-100',
                      )}
                      title={pinned ? '取消置顶' : '置顶会话'}
                      aria-label={pinned ? '取消置顶会话' : '置顶会话'}
                    >
                      {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => onDeleteSession(session.SessionId, event)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-sidebar-text-muted hover:bg-sidebar-active hover:text-rose-500"
                      title="删除会话"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-dashed border-black/[0.08] px-3 py-8 text-center text-xs text-sidebar-text-muted dark:border-white/[0.1]">
              没有匹配的会话
            </div>
          )}
          {isLoadingSessions ? (
            <div className="flex items-center justify-center gap-2 px-3 py-3 text-xs text-sidebar-text-muted">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>加载中</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-black/[0.06] px-4 py-3 text-center dark:border-white/[0.08]">
        <div className="text-[10px] font-medium tracking-[0.14em] text-sidebar-text-muted">
          POWERED BY
        </div>
        <div className="mt-1 bg-gradient-to-r from-blue-600 to-indigo-500 bg-clip-text text-xs font-bold text-transparent dark:from-blue-400 dark:to-indigo-300">
          Ksyun AgentEngine
        </div>
        <div className="mx-auto mt-2 max-w-[13rem] text-[10px] leading-4 text-sidebar-text-muted">
          Agent 可能产生不准确的信息，请独立验证。
        </div>
      </div>
    </div>
  );
}
