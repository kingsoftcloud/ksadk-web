export class ApiError extends Error {
  code: number;
  detail?: unknown;

  constructor(code: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

export class StreamError extends Error {
  event: string;
  raw?: string;

  constructor(event: string, raw?: string, message?: string) {
    super(message || `SSE 流中断于 ${event}`);
    this.name = 'StreamError';
    this.event = event;
    this.raw = raw;
  }
}

export class CancelledError extends Error {
  constructor(message = '请求已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

const API_BASE = '/agentengine/api/v1';

export type AgentEngineFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AgentEngineClientOptions = {
  fetch?: AgentEngineFetch;
  baseUrl?: string;
  /**
   * Scope every action to one agent. Embedded hosts such as Studio should set
   * this instead of selecting an agent through a process-wide cookie.
   */
  agentId?: string;
};

async function parseActionResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    // Hosted Agent domains deliberately return an HTML 401/403 page when a
    // user opens the raw URL without the short-lived Dashboard session. This
    // is an authentication boundary, not a malformed AgentEngine response.
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    const isHostedHtmlAuthPage =
      (response.status === 401 || response.status === 403)
      && (contentType.includes('text/html') || raw.trimStart().startsWith('<'));
    if (isHostedHtmlAuthPage) {
      throw new ApiError(
        response.status,
        '访问会话已失效，请从 Dashboard 或 Studio 的云端会话重新打开 Agent。',
      );
    }
    if (!response.ok) {
      const plainMessage = raw.trim();
      throw new ApiError(
        response.status,
        plainMessage && plainMessage.length <= 256 && !plainMessage.startsWith('<')
          ? plainMessage
          : response.statusText || `HTTP ${response.status}`,
        raw,
      );
    }
    throw new ApiError(-2, '响应格式异常');
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data?.Message as string) || `HTTP ${response.status}`,
      data,
    );
  }

  if (data?.Code !== undefined && data.Code !== 0) {
    throw new ApiError(
      data.Code as number,
      (data.Message as string) || '请求失败',
      data,
    );
  }

  return data.Data as T;
}

function rethrowIfNotCancelled(error: unknown): never {
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw new CancelledError();
  }
  throw error;
}

/** 1. JSON POST — 普通 agentengine action */
export class AgentEngineClient {
  private readonly fetcher: AgentEngineFetch;

  private readonly baseUrl: string;

  private readonly agentId: string;

  constructor(options: AgentEngineClientOptions = {}) {
    this.fetcher = options.fetch || ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = String(options.baseUrl || API_BASE).replace(/\/+$/, '');
    this.agentId = String(options.agentId || '').trim();
  }

  private actionUrl(action: string): string {
    return `${this.baseUrl}/${action}`;
  }

  private scopedBody(body: Record<string, unknown>): Record<string, unknown> {
    return this.agentId && !body.AgentId ? { ...body, AgentId: this.agentId } : body;
  }

  async postJsonAction<T>(
    action: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.actionUrl(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.scopedBody(body)),
        signal: options?.signal,
      });
    } catch (error) {
      throw rethrowIfNotCancelled(error);
    }
    return parseActionResponse<T>(response);
  }

  /** 2. FormData POST — UploadFile、AddWorkspaceFile */
  async postFormAction<T>(
    action: string,
    formData: FormData,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    let response: Response;
    if (this.agentId && !formData.has('AgentId')) formData.append('AgentId', this.agentId);
    try {
      response = await this.fetcher(this.actionUrl(action), {
        method: 'POST',
        body: formData,
        signal: options?.signal,
      });
    } catch (error) {
      throw rethrowIfNotCancelled(error);
    }
    return parseActionResponse<T>(response);
  }

  /** 3. GET blob/text — GetWorkspaceFileContent、AttachmentContent */
  async getResource(
    action: string,
    params: Record<string, string>,
    options?: { signal?: AbortSignal; asText?: boolean },
  ): Promise<Blob | string> {
    const scopedParams = this.agentId && !params.AgentId
      ? { AgentId: this.agentId, ...params }
      : params;
    const qs = new URLSearchParams(scopedParams).toString();
    const url = qs ? `${this.actionUrl(action)}?${qs}` : this.actionUrl(action);
    let response: Response;
    try {
      response = await this.fetcher(url, { signal: options?.signal });
    } catch (error) {
      throw rethrowIfNotCancelled(error);
    }

    if (!response.ok) {
      throw new ApiError(response.status, `资源获取失败: ${response.statusText}`);
    }

    try {
      return options?.asText ? await response.text() : await response.blob();
    } catch {
      throw new ApiError(-3, '文件读取失败');
    }
  }

  /** 4. SSE stream — RunAgent / SubscribeRunEvents */
  async streamAction(
    action: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    let response: Response;
    try {
      response = await this.fetcher(this.actionUrl(action), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(this.scopedBody(body)),
        signal: options?.signal,
      });
    } catch (error) {
      throw rethrowIfNotCancelled(error);
    }

    if (!response.ok) {
      throw new ApiError(response.status, `流式请求失败: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (contentType.includes('application/json')) {
      // Action endpoints sometimes carry business failures in an HTTP 200 JSON
      // envelope. Validate a clone so successful legacy JSON responses keep
      // their original body while rejected admissions never masquerade as SSE.
      await parseActionResponse(response.clone());
    }

    if (!response.body) {
      throw new ApiError(-1, '无法获取响应流');
    }

    return response.body;
  }

  /** GET SSE stream — SubscribeRunEvents 用 query params */
  async streamGetAction(
    action: string,
    params: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    const scopedParams = this.agentId && !params.AgentId
      ? { AgentId: this.agentId, ...params }
      : params;
    const qs = new URLSearchParams(scopedParams).toString();
    const url = qs ? `${this.actionUrl(action)}?${qs}` : this.actionUrl(action);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { Accept: 'text/event-stream' },
        signal: options?.signal,
      });
    } catch (error) {
      throw rethrowIfNotCancelled(error);
    }

    if (!response.ok) {
      throw new ApiError(response.status, `流式订阅失败: ${response.statusText}`);
    }

    if (!response.body) {
      throw new ApiError(-1, '无法获取响应流');
    }

    return response.body;
  }
}

const defaultAgentEngineClient = new AgentEngineClient();

export const postJsonAction = <T>(
  action: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> => defaultAgentEngineClient.postJsonAction<T>(action, body, options);

export const postFormAction = <T>(
  action: string,
  formData: FormData,
  options?: { signal?: AbortSignal },
): Promise<T> => defaultAgentEngineClient.postFormAction<T>(action, formData, options);

export const getResource = (
  action: string,
  params: Record<string, string>,
  options?: { signal?: AbortSignal; asText?: boolean },
): Promise<Blob | string> => defaultAgentEngineClient.getResource(action, params, options);

export const streamAction = (
  action: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> => defaultAgentEngineClient.streamAction(action, body, options);

export const streamGetAction = (
  action: string,
  params: Record<string, string>,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> => defaultAgentEngineClient.streamGetAction(action, params, options);
