import { postJsonAction, streamAction } from './client.js';

export type ListSessionCheckpointsParams = {
  agentId: string;
  sessionId: string;
  runId?: string;
};

export type ResumeRunParams = {
  agentId: string;
  sessionId: string;
  runId: string;
  checkpointId: string;
  resumeAttemptId?: string;
  invocationId?: string;
};

export type GetCheckpointResumePreviewParams = {
  agentId: string;
  sessionId: string;
  runId: string;
  checkpointId: string;
};

export type ListToolReceiptsParams = {
  agentId: string;
  sessionId: string;
  runId?: string;
  checkpointId?: string;
};

export async function listSessionCheckpoints(
  params: ListSessionCheckpointsParams,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const body: Record<string, unknown> = {
    AgentId: params.agentId,
    SessionId: params.sessionId,
  };
  if (params.runId) {
    body.RunId = params.runId;
  }
  return postJsonAction('ListSessionCheckpoints', body, options);
}

export async function previewCheckpointResume(
  params: GetCheckpointResumePreviewParams,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  return postJsonAction('GetCheckpointResumePreview', {
    AgentId: params.agentId,
    SessionId: params.sessionId,
    RunId: params.runId,
    CheckpointId: params.checkpointId,
  }, options);
}

export async function listToolReceipts(
  params: ListToolReceiptsParams,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const body: Record<string, unknown> = {
    AgentId: params.agentId,
    SessionId: params.sessionId,
  };
  if (params.runId) {
    body.RunId = params.runId;
  }
  if (params.checkpointId) {
    body.CheckpointId = params.checkpointId;
  }
  return postJsonAction('ListToolReceipts', body, options);
}

export async function resumeRun(
  params: ResumeRunParams,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  const body: Record<string, unknown> = {
    AgentId: params.agentId,
    SessionId: params.sessionId,
    RunId: params.runId,
    CheckpointId: params.checkpointId,
    Stream: true,
  };
  if (params.resumeAttemptId) {
    body.ResumeAttemptId = params.resumeAttemptId;
  }
  if (params.invocationId) {
    body.InvocationId = params.invocationId;
  }
  return streamAction('ResumeRun', body, options);
}
