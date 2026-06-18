import { useMemo, useState, type MouseEvent, type UIEvent } from 'react';

import { LoaderCircle, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';

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
    <div className={cn('flex h-full min-h-0 flex-col bg-slate-50 dark:bg-slate-950/80', className)}>
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-slate-200/30 px-3 py-3 dark:border-slate-800">
        <button
          type="button"
          onClick={onCreateNewSession}
          className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-sm font-medium transition-colors hover:bg-slate-200/60 dark:hover:bg-slate-800"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <span>新对话</span>
          </span>
          <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            ⌘ N
          </span>
        </button>
        <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:focus-within:border-blue-800 dark:focus-within:ring-blue-950/60">
          <Search className="h-3.5 w-3.5 flex-shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-200"
            placeholder="搜索会话、模型或摘要"
          />
        </label>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 custom-scrollbar"
        onScroll={handleScroll}
      >
        <div className="px-2 py-2 text-xs font-semibold text-slate-400 dark:text-slate-500">
          历史记录{query.trim() ? ` · ${visibleSessions.length}` : ''}
        </div>
        <div className="flex flex-col gap-1.5">
          {visibleSessions.length > 0 ? (
            visibleSessions.map((session) => {
              const meta = resolveCompactSessionMeta(session);
              const pinned = pinnedSet.has(session.SessionId);
              return (
                <div
                  key={session.SessionId}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSession(session.SessionId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectSession(session.SessionId);
                    }
                  }}
                  className={cn(
                    'group flex items-center justify-between gap-3 rounded-2xl px-3 py-3 text-sm transition-colors',
                    currentSessionId === session.SessionId
                      ? 'bg-slate-200/90 font-medium text-slate-950 dark:bg-slate-800 dark:text-slate-50'
                      : 'cursor-pointer text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60',
                  )}
                >
                  <div className="min-w-0 flex-1 truncate text-[15px] leading-6">
                    {sessionTitle(session)}
                  </div>
                  {meta.running ? (
                    <LoaderCircle className="h-4 w-4 flex-shrink-0 animate-spin text-slate-400 dark:text-slate-500" />
                  ) : meta.label ? (
                    <span className="flex-shrink-0 text-[11px] leading-none text-slate-400 dark:text-slate-500">
                      {meta.label}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => onTogglePinSession(session.SessionId, event)}
                    className={cn(
                      'rounded-lg p-1.5 transition hover:bg-white md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-slate-900',
                      pinned ? 'text-blue-500 opacity-100' : 'text-slate-400',
                    )}
                    title={pinned ? '取消置顶' : '置顶会话'}
                    aria-label={pinned ? '取消置顶会话' : '置顶会话'}
                  >
                    {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => onDeleteSession(session.SessionId, event)}
                    className="hidden rounded-lg p-1.5 text-slate-400 transition hover:bg-white hover:text-rose-500 md:group-hover:block dark:hover:bg-slate-900"
                    title="Delete chat"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              没有匹配的会话
            </div>
          )}
          {isLoadingSessions ? (
            <div className="flex items-center justify-center gap-2 px-3 py-3 text-xs text-slate-400">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>加载中</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-slate-200/30 px-4 py-3 text-center dark:border-slate-800">
        <div className="text-[10px] font-medium tracking-[0.14em] text-slate-400 dark:text-slate-500">
          POWERED BY
        </div>
        <div className="mt-1 bg-gradient-to-r from-blue-600 to-indigo-500 bg-clip-text text-xs font-bold text-transparent dark:from-blue-400 dark:to-indigo-300">
          Ksyun AgentEngine
        </div>
        <div className="mx-auto mt-2 max-w-[13rem] text-[10px] leading-4 text-slate-400 dark:text-slate-500">
          Agent 可能产生不准确的信息，请独立验证。
        </div>
      </div>
    </div>
  );
}
