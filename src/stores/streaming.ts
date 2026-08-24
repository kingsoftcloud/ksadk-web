import { create } from 'zustand';

import {
  RuntimeItemReducer,
  type RuntimeItemOperation,
  type RuntimeItemSnapshot,
} from '../core/stream/runtime-items.js';

export type RunActivityStatus = 'connecting' | 'running' | 'waiting' | 'stopped' | 'completed' | 'failed';

export type StatusBannerKind = 'rate_limited' | 'network' | 'error';

export type StatusBanner = {
  kind: StatusBannerKind;
  message: string;
  retryAfterSec?: number;
  sessionId?: string | null;
  createdAt?: number;
};

export type RunActivity = {
  runId?: string;
  source: 'run' | 'restore';
  status: RunActivityStatus;
  phase: string;
  detail?: string;
  startedAt: number;
  lastEventAt: number;
  eventCount: number;
};

export type StreamingState = {
  isStreaming: boolean;
  currentRunId: string;
  stopRequested: boolean;
  activity: RunActivity | null;
  sessionActivities: Record<string, RunActivity>;
  sessionStreaming: Record<string, true>;
  banner: StatusBanner | null;
  /** 当前 run 的最后事件 seq_id,用于网络断线后 afterSeqId 续订重连。 */
  lastSeqId: number;
  /** 当前 run 的 invocationId(afterSeqId 续订需要)。 */
  activeInvocationId: string;
  /** 当前 run 的 identity-aware item 投影(schema v2),替代 v1 启发式去重。 */
  runtimeItems: RuntimeItemSnapshot;
};

export type StreamingActions = {
  setStreaming: (streaming: boolean) => void;
  setSessionStreaming: (sessionId: string | null | undefined, streaming: boolean) => void;
  isSessionStreaming: (sessionId: string | null | undefined) => boolean;
  getSessionActivity: (sessionId: string | null | undefined) => RunActivity | null;
  setCurrentRunId: (runId: string) => void;
  requestStop: () => void;
  setBanner: (banner: StatusBanner | null) => void;
  setLastSeqId: (seqId: number) => void;
  setActiveInvocationId: (invocationId: string) => void;
  beginActivity: (activity: {
    runId?: string;
    source?: RunActivity['source'];
    status?: RunActivityStatus;
    phase: string;
    detail?: string;
  }) => void;
  updateActivity: (activity: {
    sessionId?: string | null;
    source?: RunActivity['source'];
    status?: RunActivityStatus;
    phase?: string;
    detail?: string;
    countEvent?: boolean;
  }) => void;
  stopActivity: (detail?: string) => void;
  stopSessionActivity: (sessionId?: string | null, detail?: string) => void;
  clearActivity: () => void;
  clearSessionActivity: (sessionId?: string | null) => void;
  /**
   * 应用 identity-aware item 操作到当前 run 的 RuntimeItemReducer。
   * 操作按 runId/scopeId/itemId/partId 归并;eventId 重放是幂等 no-op。
   */
  applyRuntimeItemOperations: (operations: RuntimeItemOperation[]) => void;
  resetRun: () => void;
};

export type StreamingStore = StreamingState & StreamingActions;

const hasStreamingSession = (sessions: Record<string, true>): boolean => Object.keys(sessions).length > 0;

const EMPTY_RUNTIME_ITEMS: RuntimeItemSnapshot = { runId: null, status: null, items: [] };

/**
 * 当前 run 的 canonical reducer 实例。放在 store state 外(reducer 自身是可变
 * accumulator),state 里只暴露只读 snapshot,保证 React 依赖 snapshot 引用变化重渲染。
 */
let runtimeItemReducer = new RuntimeItemReducer();

const withoutStreamingSession = (sessions: Record<string, true>, key: string): Record<string, true> => {
  const next = { ...sessions };
  delete next[key];
  return next;
};

export const useStreamingStore = create<StreamingStore>()((set, get) => ({
  isStreaming: false,
  currentRunId: '',
  stopRequested: false,
  activity: null,
  sessionActivities: {},
  sessionStreaming: {},
  banner: null,
  lastSeqId: 0,
  activeInvocationId: '',
  runtimeItems: EMPTY_RUNTIME_ITEMS,
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setBanner: (banner) => set({
    banner: banner ? { ...banner, createdAt: Date.now() } : null,
  }),
  setLastSeqId: (seqId) => set({ lastSeqId: seqId }),
  setActiveInvocationId: (invocationId) => set({ activeInvocationId: invocationId }),
  setSessionStreaming: (sessionId, streaming) => set((state) => {
    const key = String(sessionId || '');
    if (!key) return { isStreaming: streaming };
    const remaining = withoutStreamingSession(state.sessionStreaming, key);
    const sessionStreaming = streaming ? { ...remaining, [key]: true as const } : remaining;
    return {
      sessionStreaming,
      isStreaming: hasStreamingSession(sessionStreaming),
    };
  }),
  isSessionStreaming: (sessionId) => {
    const key = String(sessionId || '');
    return Boolean(key && get().sessionStreaming[key]);
  },
  getSessionActivity: (sessionId) => {
    const key = String(sessionId || '');
    if (!key) return null;
    return get().sessionActivities[key] || null;
  },
  setCurrentRunId: (runId) => set({ currentRunId: runId }),
  requestStop: () => set({ stopRequested: true }),
  beginActivity: (activity) => set({
    stopRequested: false,
    activity: {
      runId: activity.runId,
      source: activity.source || 'run',
      status: activity.status || 'running',
      phase: activity.phase,
      detail: activity.detail,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      eventCount: 0,
    },
  }),
  updateActivity: (activity) => set((state) => {
    const key = String(activity.sessionId || '');
    const current = key ? state.sessionActivities[key] : state.activity;
    const nextActivity = current
      ? {
          ...current,
          source: activity.source || current.source,
          status: activity.status || current.status,
          phase: activity.phase || current.phase,
          detail: activity.detail === undefined ? current.detail : activity.detail,
          lastEventAt: Date.now(),
          eventCount: current.eventCount + (activity.countEvent === false ? 0 : 1),
        }
      : {
          source: activity.source || 'run' as const,
          status: activity.status || 'running',
          phase: activity.phase || '正在运行',
          detail: activity.detail,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          eventCount: activity.countEvent === false ? 0 : 1,
        };
    if (key) {
      return {
        isStreaming: hasStreamingSession(state.sessionStreaming),
        sessionActivities: {
          ...state.sessionActivities,
          [key]: nextActivity,
        },
        activity: nextActivity,
      };
    }
    if (!current) {
      return {
        activity: nextActivity,
      };
    }
    return {
      activity: nextActivity,
    };
  }),
  stopActivity: (detail) => set((state) => ({
    isStreaming: false,
    stopRequested: true,
    activity: state.activity
      ? {
        ...state.activity,
        status: 'stopped',
        phase: '已断开输出流',
        detail: detail || '前端已断开本次输出流；后台运行可稍后通过会话记录继续查看。',
        lastEventAt: Date.now(),
      }
      : null,
  })),
  stopSessionActivity: (sessionId, detail) => set((state) => {
    const key = String(sessionId || '');
    if (!key) return {};
    const current = state.sessionActivities[key];
    if (!current) return {};
    const nextActivity = {
      ...current,
      status: 'stopped' as const,
      phase: '已断开输出流',
      detail: detail || '前端已断开本次输出流；后台运行可稍后通过会话记录继续查看。',
      lastEventAt: Date.now(),
    };
    const sessionActivities = { ...state.sessionActivities, [key]: nextActivity };
    const sessionStreaming = withoutStreamingSession(state.sessionStreaming, key);
    return {
      isStreaming: hasStreamingSession(sessionStreaming),
      activity: nextActivity,
      sessionActivities,
      sessionStreaming,
    };
  }),
  clearActivity: () => set({ activity: null }),
  clearSessionActivity: (sessionId) => set((state) => {
    const key = String(sessionId || '');
    if (!key) return {};
    const { [key]: _removed, ...sessionActivities } = state.sessionActivities;
    const sessionStreaming = withoutStreamingSession(state.sessionStreaming, key);
    return {
      sessionActivities,
      sessionStreaming,
      isStreaming: hasStreamingSession(sessionStreaming),
      activity: state.activity === _removed ? null : state.activity,
    };
  }),
  applyRuntimeItemOperations: (operations) => {
    runtimeItemReducer.applyAll(operations);
    set({ runtimeItems: runtimeItemReducer.snapshot() });
  },
  resetRun: () => {
    runtimeItemReducer = new RuntimeItemReducer();
    set({
    isStreaming: false,
    currentRunId: '',
    stopRequested: false,
    activity: null,
    sessionActivities: {},
    sessionStreaming: {},
    lastSeqId: 0,
    activeInvocationId: '',
    runtimeItems: EMPTY_RUNTIME_ITEMS,
    });
  },
}));
