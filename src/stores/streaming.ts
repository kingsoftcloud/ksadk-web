import { create } from 'zustand';

export type RunActivityStatus = 'connecting' | 'running' | 'waiting' | 'stopped' | 'completed' | 'failed';

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
};

export type StreamingActions = {
  setStreaming: (streaming: boolean) => void;
  setSessionStreaming: (sessionId: string | null | undefined, streaming: boolean) => void;
  isSessionStreaming: (sessionId: string | null | undefined) => boolean;
  getSessionActivity: (sessionId: string | null | undefined) => RunActivity | null;
  setCurrentRunId: (runId: string) => void;
  requestStop: () => void;
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
  resetRun: () => void;
};

export type StreamingStore = StreamingState & StreamingActions;

const hasStreamingSession = (sessions: Record<string, true>): boolean => Object.keys(sessions).length > 0;

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
  setStreaming: (streaming) => set({ isStreaming: streaming }),
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
  resetRun: () => set({
    isStreaming: false,
    currentRunId: '',
    stopRequested: false,
    activity: null,
    sessionActivities: {},
    sessionStreaming: {},
  }),
}));
