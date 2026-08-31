import type { RunEvent } from './types.js';
import {
  appendThinkingBlock,
  appendTextBlock,
  finalizeTextBlock,
  finalizeThinkingBlocks,
  upsertToolBlock,
} from './blocks.js';
import { useMessageStore } from '../../stores/message.js';
import {
  ingestApprovalRequestedEvent,
  ingestSessionEventRecord,
} from '../interaction/index.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useSessionStore } from '../../stores/session.js';
import { useCheckpointStore } from '../../stores/checkpoint.js';
import {
  buildCompactionMessage,
  eventHasTerminalRunStatus,
  mergeSessionEventRecords,
  sessionEventRunStatus,
} from '../../utils/session-events.js';
import { mergeRecoveredRunMessages } from '../../utils/recovered-run.js';
import { isFailedToolOutput } from '../../utils/tool-display.js';
import type { Message } from '../../components/chat/types.js';
import {
  mergeConversationRunMessages,
  projectConversationStreamForHostedUi,
} from '../conversation/hosted.js';
import { sharedInteractionStore } from '../interaction/index.js';

const TERMINAL_COMPLETE_STATUSES = new Set(['completed']);
const TERMINAL_ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'aborted', 'incomplete']);

const recoveredEventsByRun = new Map<string, import('../../types/session-events.js').SessionEventRecord[]>();

function ensureAssistantMessage(id: string, invocationId?: string) {
  useMessageStore.getState().patchMessages((prev) => {
    if (prev.some((message) => message.id === id)) {
      return invocationId
        ? prev.map((message) => message.id === id ? { ...message, invocationId } : message)
        : prev;
    }
    return [
      ...prev,
      { id, role: 'model', content: '', timestamp: Date.now(), reasoning: '', invocationId },
    ];
  });
}

function settleRunningToolsForTerminalStatus(status: string) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const nextStatus = TERMINAL_COMPLETE_STATUSES.has(normalizedStatus)
    ? 'completed'
    : TERMINAL_ERROR_STATUSES.has(normalizedStatus)
      ? 'error'
      : null;
  if (!nextStatus) return;

  useMessageStore.getState().patchMessages((prev) =>
    prev.map((msg) => {
      if (!msg.tools) return msg;
      let changed = false;
      const tools = Object.fromEntries(
        Object.entries(msg.tools).map(([name, tool]) => {
          if (tool.status !== 'running') return [name, tool];
          changed = true;
          return [name, { ...tool, status: nextStatus }];
        }),
      ) as NonNullable<Message['tools']>;
      return changed ? { ...msg, tools } : msg;
    }),
  );
}

export function dispatchRunEventToStores(event: RunEvent) {
  const sessionIsOffscreen = Boolean(
    event.sessionId && useSessionStore.getState().currentSessionId !== event.sessionId,
  );
  // Text blocks belong to the visible transcript and must not leak across a
  // session switch. Lifecycle events are different: a Responses stream can
  // complete while its session is offscreen, and dropping that terminal event
  // leaves the session permanently marked as "generating" when the user
  // returns.
  if (
    sessionIsOffscreen
    && !['activity', 'stage_changed', 'stream_ended', 'error', 'rate_limited', 'terminal'].includes(event.type)
  ) {
    return;
  }

  const ms = useMessageStore.getState();

  // 真正的流式事件(text/tool/reasoning delta)也计入 ev 计数 + 更新 lastEventAt。
  // 以前这些事件走 activity 通道会自然累加;改走 blocks 后不再触发 updateActivity,
  // 导致 ev 一直 0。这里显式 bump,保持"运行中"心跳 + 事件计数准确。
  const bumpEventCount = (sessionId?: string | null) => {
    if (!sessionId) return;
    useStreamingStore.getState().updateActivity({ sessionId });
  };

  switch (event.type) {
    case 'activity':
      useStreamingStore.getState().updateActivity({
        sessionId: event.sessionId,
        source: event.source,
        status: event.status,
        phase: event.phase,
        detail: event.detail,
        countEvent: event.countEvent,
      });
      break;

    case 'user_message_added':
      useStreamingStore.getState().setBanner(null);
      ms.patchMessages((prev) => [
        ...prev,
        { id: event.messageId, role: 'user', content: '', timestamp: Date.now() },
      ]);
      break;

    case 'assistant_message_created':
      ensureAssistantMessage(event.messageId, event.invocationId);
      break;

    case 'text_delta':
      ensureAssistantMessage(event.messageId);
      bumpEventCount(event.sessionId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? {
                ...msg,
                content: msg.content + event.delta,
                blocks: appendTextBlock(msg.blocks, event.delta),
              }
            : msg,
        ),
      );
      break;

    case 'text_final':
      ensureAssistantMessage(event.messageId);
      bumpEventCount(event.sessionId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? {
                ...msg,
                content: event.text,
                blocks: finalizeTextBlock(msg.blocks, event.text),
              }
            : msg,
        ),
      );
      break;

    case 'reasoning_delta':
      ensureAssistantMessage(event.messageId);
      bumpEventCount(event.sessionId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? {
                ...msg,
                reasoning: (msg.reasoning || '') + event.delta,
                blocks: appendThinkingBlock(msg.blocks, event.delta),
              }
            : msg,
        ),
      );
      break;

    case 'tool_upsert': {
      ensureAssistantMessage(event.messageId);
      bumpEventCount(event.sessionId);
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          const current = msg.tools?.[event.name];
          const currentApprovalResolved = current?.approvalStatus === 'approved'
            || current?.approvalStatus === 'rejected';
          const requestedStatus = event.status as NonNullable<Message['tools']>[string]['status'];
          // Approval is an audit state, not the tool outcome. A granted tool
          // still needs to enter running and may subsequently fail.
          const status = current?.approvalStatus === 'rejected'
            ? 'completed'
            : current?.status === 'error' && requestedStatus !== 'error'
              ? 'error'
              : requestedStatus;
          return {
            ...msg,
            blocks: upsertToolBlock(msg.blocks, event.name, {
              args: event.args,
              status,
              extra: event.extra as Record<string, unknown> | undefined,
            }),
            tools: {
              ...(msg.tools || {}),
              [event.name]: {
                ...(current || { name: event.name, args: '' }),
                name: event.name,
                args: event.args,
                status,
                ...(event.extra || {}),
                ...(event.extra?.approvalRequestId && !currentApprovalResolved
                  ? { approvalStatus: 'pending' as const }
                  : {}),
              },
            },
          };
        }),
      );
      break;
    }

    case 'tool_result':
      ensureAssistantMessage(event.messageId);
      bumpEventCount(event.sessionId);
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          const status = isFailedToolOutput(event.output) ? 'error' : 'completed';
          return {
            ...msg,
            blocks: upsertToolBlock(msg.blocks, event.name, {
              output: event.output,
              status,
            }),
            tools: {
              ...(msg.tools || {}),
              [event.name]: {
                ...(msg.tools?.[event.name] || { name: event.name, args: '' }),
                output: event.output,
                status,
              },
            },
          };
        }),
      );
      break;

    case 'approval_requested': {
      ensureAssistantMessage(event.messageId);
      ingestApprovalRequestedEvent({
        approvalRequestId: event.approvalRequestId,
        protocol: event.protocol,
        name: event.name,
        message: event.message,
        args: event.args,
        approvalLevel: event.approvalLevel,
        sessionId: event.sessionId,
      });
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          const existing = msg.tools?.[event.approvalRequestId];
          const alreadyResolved = existing?.approvalStatus === 'approved'
            || existing?.approvalStatus === 'rejected';
          const approvalExtra = {
            approvalRequestId: event.approvalRequestId,
            approvalProtocol: event.protocol,
            approvalStatus: alreadyResolved ? existing.approvalStatus : 'pending' as const,
            ...(event.message ? { approvalMessage: event.message } : {}),
            ...(event.approvalLevel ? { approvalLevel: event.approvalLevel } : {}),
          };
          const status = alreadyResolved ? existing.status : 'paused';
          return {
            ...msg,
            // 同步审批状态到 blocks(ToolRow 从 block.extra 读审批字段渲染审批卡)
            blocks: upsertToolBlock(msg.blocks, event.name, {
              args: event.args,
              status,
              extra: approvalExtra,
            }),
            tools: {
              ...(msg.tools || {}),
              [event.approvalRequestId]: {
                ...(existing || {}),
                name: event.name,
                args: event.args,
                status,
                ...approvalExtra,
              },
            },
          };
        }),
      );
      break;
    }

    case 'approval_resolved':
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (!msg.tools) return msg;
          let changed = false;
          const tools = Object.fromEntries(
            Object.entries(msg.tools).map(([key, tool]) => {
              if (tool.approvalRequestId !== event.approvalRequestId) return [key, tool];
              changed = true;
              const status = event.decision === 'rejected'
                ? 'completed' as const
                : tool.status === 'paused'
                  ? 'running' as const
                  : tool.status;
              return [key, {
                ...tool,
                status,
                approvalStatus: event.decision,
              }];
            }),
          ) as NonNullable<Message['tools']>;
          if (!changed) return msg;
          return {
            ...msg,
            tools,
            blocks: msg.blocks?.map((block) => {
              if (block.type !== 'tool' || block.extra?.approvalRequestId !== event.approvalRequestId) {
                return block;
              }
              const status = event.decision === 'rejected'
                ? 'completed' as const
                : block.status === 'paused'
                  ? 'running' as const
                  : block.status;
              return {
                ...block,
                status,
                extra: { ...block.extra, approvalStatus: event.decision },
              };
            }),
          };
        }),
      );
      break;

    case 'system_message':
      ms.patchMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + Math.random()),
          role: 'system',
          content: event.content,
          timestamp: Date.now(),
        },
      ]);
      break;

    case 'compaction': {
      const compactionId = `compaction-${Date.now()}`;
      const status: Message['status'] =
        event.phase === 'start' ? 'running'
          : event.phase === 'failed' ? 'failed'
          : 'completed';
      const compactionMsg = buildCompactionMessage({
        id: compactionId,
        timestamp: Date.now(),
        status,
        trigger: event.trigger,
        compactedUntilSeqId: event.compactedUntilSeqId,
      });
      ms.patchMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === compactionId);
        if (existingIndex < 0) return [...prev, compactionMsg as Message];
        return prev.map((m) => (m.id === compactionId ? { ...m, ...compactionMsg } : m));
      });
      break;
    }

    case 'stage_changed':
      if (event.stage === 'streaming' || event.stage === 'connecting') {
        useStreamingStore.getState().setSessionStreaming(event.sessionId, true);
      } else if (event.stage === 'completing' || event.stage === 'error' || event.stage === 'cancelled') {
        useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      }
      break;

    case 'stream_ended':
      useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      // 流式结束:把该 session 所有 assistant 消息里仍 streaming 的
      // thinking/text 块置 done。否则纯思考结束(后面无工具/正文打断)时
      // thinking 块一直卡在 streaming,显示"思考中"不完成,要刷新才好。
      if (!sessionIsOffscreen) {
        useMessageStore.getState().patchMessages((prev) =>
          prev.map((msg) => {
            const belongsToEndedRun = !event.runId
              || msg.runId === event.runId
              || msg.invocationId === event.runId;
            if (
              !belongsToEndedRun
              || msg.role !== 'model'
              || !msg.blocks?.some((b) => b.status === 'streaming')
            ) {
              return msg;
            }
            return {
              ...msg,
              blocks: finalizeThinkingBlocks(
                msg.blocks.map((b) =>
                  b.type === 'text' && b.status === 'streaming'
                    ? { ...b, status: 'done' as const }
                    : b,
                ),
              ),
            };
          }),
        );
      }
      globalThis.setTimeout(() => {
        const state = useStreamingStore.getState();
        const activity = state.getSessionActivity(event.sessionId);
        if (activity?.status === 'completed') {
          state.clearSessionActivity(event.sessionId);
        }
      }, 2400);
      break;

    case 'error':
      useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      useStreamingStore.getState().updateActivity({
        sessionId: event.sessionId,
        status: 'failed',
        phase: '连接断开或生成出错',
        countEvent: false,
      });
      if (!sessionIsOffscreen) {
        useStreamingStore.getState().setBanner({
          kind: 'error',
          message: '连接断开或生成出错，请重试',
          sessionId: event.sessionId,
        });
        ms.patchMessages((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            role: 'model',
            content: '连接断开或生成出错。',
            timestamp: Date.now(),
          },
        ]);
      }
      break;

    case 'rate_limited':
      useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      useStreamingStore.getState().updateActivity({
        sessionId: event.sessionId,
        status: 'failed',
        phase: '请求被限流',
        countEvent: false,
      });
      if (!sessionIsOffscreen) {
        useStreamingStore.getState().setBanner({
          kind: 'rate_limited',
          message: event.message || '请求过于频繁，请稍后重试',
          retryAfterSec: event.retryAfterSec,
          sessionId: event.sessionId,
        });
      }
      break;

    case 'terminal':
      if (!sessionIsOffscreen) {
        settleRunningToolsForTerminalStatus(event.status);
      }
      break;

    case 'stream_event': {
      const streamSessionId = event.sessionId || event.event.SessionId;
      ingestSessionEventRecord(event.event, streamSessionId || undefined);
      // 记录最后事件 seq,供网络断线后 afterSeqId 续订重连。
      const evtSeq = (event.event as { SeqId?: number }).SeqId;
      if (typeof evtSeq === 'number' && evtSeq > 0) {
        useStreamingStore.getState().setLastSeqId(evtSeq);
      }
      if (streamSessionId) {
        useStreamingStore.getState().updateActivity({ sessionId: streamSessionId });
      }
      const invocationId = String(event.event.InvocationId || '').trim();
      if (streamSessionId && invocationId) {
        const runKey = `${streamSessionId}:${invocationId}`;
        const recoveredEvents = mergeSessionEventRecords(
          recoveredEventsByRun.get(runKey) || [],
          [event.event],
        );
        recoveredEventsByRun.set(runKey, recoveredEvents);
        useMessageStore.getState().patchMessages((prev) => {
          // ConversationItem/v1 is the single presentation owner for a
          // canonical run. SubscribeSessionEvents remains useful for durable
          // interactions, checkpoints and lifecycle, but projecting the same
          // output through the legacy read model creates a second live answer.
          const canonicalOwnsRun = prev.some((message) => (
            message.eventType === 'conversation_item_v1'
            && message.runId === invocationId
          ));
          return canonicalOwnsRun
            ? prev
            : mergeRecoveredRunMessages(prev, recoveredEvents, invocationId);
        });
        if (eventHasTerminalRunStatus(event.event)) {
          recoveredEventsByRun.delete(runKey);
        }
      }
      if (event.event.EventType === 'run_checkpoint' && streamSessionId) {
        useCheckpointStore.getState().upsertSessionCheckpoint(streamSessionId, event.event);
      }
      {
        const status = sessionEventRunStatus(event.event);
        if (status === 'completed') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'completed',
            phase: '后台长任务已完成',
            countEvent: false,
          });
        } else if (status === 'cancelled' || status === 'canceled' || status === 'aborted') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'stopped',
            phase: '后台长任务已取消',
            countEvent: false,
          });
        } else if (status === 'failed' || status === 'error') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'failed',
            phase: '后台长任务失败',
            countEvent: false,
          });
        }
      }
      break;
    }

    case 'conversation_snapshot': {
      const projected = projectConversationStreamForHostedUi(event.result);
      for (const interaction of projected.interactions) {
        sharedInteractionStore.upsert(interaction);
      }
      ms.patchMessages((previous) => mergeConversationRunMessages(
        previous,
        event.result,
      ));
      bumpEventCount(event.sessionId);
      break;
    }

    case 'a2ui_surface_begin': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) => {
        const without = prev.filter((m) => m.id !== msgId);
        return [
          ...without,
          {
            id: msgId,
            role: 'a2ui' as const,
            content: '',
            timestamp: Date.now(),
            a2ui: {
              surfaceId: event.surfaceId,
              surface: event.surface,
            },
          },
        ];
      });
      break;
    }

    case 'a2ui_surface_update': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? { ...m, a2ui: { ...m.a2ui, surface: event.surface } }
            : m,
        ),
      );
      break;
    }

    case 'a2ui_surface_end': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? { ...m, a2ui: { ...m.a2ui, ended: true } }
            : m,
        ),
      );
      break;
    }

    case 'a2ui_interaction': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? {
                ...m,
                a2ui: {
                  ...m.a2ui,
                  pendingInteraction: {
                    interactionId: event.interactionId,
                    kind: event.kind,
                    inputSchema: event.inputSchema,
                  },
                },
              }
            : m,
        ),
      );
      break;
    }

    case 'agui_activity': {
      const msgId = `agui-a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) => {
        const activity = { surfaceId: event.surfaceId, messages: event.messages };
        let attached = false;
        const withAttachedActivity = prev.map((message) => {
          if (message.id !== event.messageId) return message;
          attached = true;
          const prior = message.aguiActivities || [];
          const next = [
            ...prior.filter((item) => item.surfaceId !== event.surfaceId),
            activity,
          ];
          return { ...message, aguiActivities: next };
        });
        if (attached) return withAttachedActivity;

        // An activity can legally arrive before the assistant message. Keep
        // the existing standalone fallback for that edge case and for replay.
        const current = prev.find((message) => message.id === msgId);
        const nextMessage: Message = {
          id: msgId,
          role: 'a2ui',
          content: '',
          timestamp: current?.timestamp || Date.now(),
          aguiActivity: activity,
        };
        return current
          ? prev.map((message) => message.id === msgId ? nextMessage : message)
          : [...prev, nextMessage];
      });
      break;
    }
  }
}

export function resetDispatcherState() {
  recoveredEventsByRun.clear();
  // Kept for test and session lifecycle callers. Message existence is now the
  // source of truth, so switching sessions cannot drop a live AG-UI event.
}
