const TOOL_STATUS_MAP = {
  running: 'running',
  completed: 'completed',
  failed: 'error',
  paused: 'paused',
  approved: 'completed',
  denied: 'completed',
};

const APPROVAL_STATUS_MAP = {
  paused: 'pending',
  approved: 'approved',
  denied: 'rejected',
};

function parseTimestamp(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content.parts)) {
      return content.parts
        .map((part) =>
          part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '',
        )
        .join('');
    }
  }
  return '';
}

function mapToolEvents(toolEvents) {
  const tools = {};
  for (const te of toolEvents ?? []) {
    if (!te?.Name) continue;
    const status = TOOL_STATUS_MAP[String(te.Status ?? 'completed').toLowerCase()] ?? 'completed';
    const entry = {
      name: te.Name,
      args: te.Args === undefined ? '' : typeof te.Args === 'string' ? te.Args : JSON.stringify(te.Args),
      status,
    };
    if (te.Result !== undefined) {
      entry.output = typeof te.Result === 'string' ? te.Result : JSON.stringify(te.Result);
    }
    if (te.ApprovalRequestId) {
      entry.approvalRequestId = te.ApprovalRequestId;
      entry.approvalStatus = APPROVAL_STATUS_MAP[String(te.Status ?? 'paused').toLowerCase()] ?? 'pending';
    }
    if (te.ToolCallId) {
      entry.previousResponseId = te.ToolCallId;
    }
    // 同名 tool 后者覆盖前者(保留最后状态)
    tools[te.Name] = entry;
  }
  return tools;
}

function mapAttachments(attachments) {
  if (!Array.isArray(attachments)) return undefined;
  return attachments.map((att) => ({
    name: att.name || '',
    url: att.url || '',
    type: att.mime || '',
    fileUri: att.file_uri,
  }));
}

export function mapBackendMessage(msg) {
  const role = msg.Role === 'assistant' ? 'model' : (msg.Role || 'user');
  const tools = msg.ToolEvents?.length ? mapToolEvents(msg.ToolEvents) : undefined;
  const attachments = mapAttachments(msg.Attachments);
  const reasoning = msg.Reasoning?.length
    ? msg.Reasoning.map((r) => r.text).join('')
    : undefined;
  const result = {
    id: msg.MessageId || `msg-${msg.SeqId ?? Math.random().toString(36).slice(2)}`,
    role,
    content: extractContentText(msg.Content),
    timestamp: parseTimestamp(msg.Timestamp),
    eventType: role === 'user' ? 'user_message' : 'assistant_message',
    reasoning,
    tools,
    attachments,
  };
  // 反馈控件需要 responseId/eventId/traceId/rootSpanId(后端从 event Metadata 投出)
  if (msg.MessageId) result.eventId = msg.MessageId;
  if (msg.ResponseId) result.responseId = msg.ResponseId;
  if (msg.TraceId) result.traceId = msg.TraceId;
  if (msg.RootSpanId) result.rootSpanId = msg.RootSpanId;
  return result;
}

export function mapBackendMessages(messages) {
  return messages.map(mapBackendMessage);
}
