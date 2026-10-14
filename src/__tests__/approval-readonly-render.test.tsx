import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMessageList } from '../components/chat/ChatMessageList.js';
import type { Message } from '../components/chat/types.js';
import { interactionFromResponsesApproval } from '../core/interaction/adapters/responses.js';
import { mapBackendMessage } from '../utils/messages.js';

const message: Message = { id: 'legacy', role: 'model', content: '', timestamp: 1,
  tools: { query: { name: 'query', status: 'paused', args: '{}',
    approvalRequestId: 'approval-1', approvalStatus: 'pending', approvalProtocol: 'responses' } } };
const block: NonNullable<Message['blocks']>[number] = {
  id: 'tool-1', type: 'tool', toolName: 'query', status: 'paused', args: '{}',
};

describe('read-only approval timeline', () => {
  it('preserves independent status for two approvals of the same tool', () => {
    const repeated = mapBackendMessage({ Role: 'assistant', ToolEvents: [
      { Name: 'query', ApprovalRequestId: 'old', Status: 'approved' },
      { Name: 'query', ApprovalRequestId: 'new', Status: 'paused' },
    ] });
    const html = renderToStaticMarkup(<ChatMessageList agentName="Agent" isMobile={false}
      isStreaming={false} activity={null} contextIndicator={null} messages={[repeated]}
      scrollRef={createRef()} onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
      onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
    expect(html).toContain('已授权');
    expect(html.match(/请在输入区确认面板中操作。/g)).toHaveLength(1);
    expect(html).not.toMatch(/允许执行|批准并继续|>拒绝<|tool-approval-card/);
  });

  it.each([false, true])('renders pending history without action buttons (blocks=%s)', blocks => {
    const html = renderToStaticMarkup(<ChatMessageList agentName="Agent" isMobile={false}
      isStreaming={false} activity={null} contextIndicator={null}
      messages={[{ ...message, ...(blocks ? { blocks: [block] } : {}) }]}
      scrollRef={createRef()} onOpenAttachmentPreview={() => {}}
      onRespondToApproval={() => { throw new Error('timeline must remain read-only'); }}
      onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
    expect(html).toContain('请在输入区确认面板中操作。');
    expect(html).not.toMatch(/允许执行|批准并继续|>拒绝<|tool-approval-card/);
  });

  it.each([false, true])('shows the terminal record over a stale pending snapshot (blocks=%s)', blocks => {
    const interaction = interactionFromResponsesApproval({ sessionId: 'session-1', approvalRequestId: 'approval-1' })!;
    const html = renderToStaticMarkup(<ChatMessageList agentName="Agent" isMobile={false}
      isStreaming={false} activity={null} contextIndicator={null}
      messages={[{ ...message, ...(blocks ? { blocks: [block] } : {}) }]}
      interactionRecords={[{ ...interaction, status: 'resolved', outcome: 'rejected' }]}
      scrollRef={createRef()} onOpenAttachmentPreview={() => {}} onRespondToApproval={() => {}}
      onSubmitFeedback={() => {}} onDeleteFeedback={() => {}} />);
    expect(html).toContain('已拒绝');
    expect(html).not.toContain('请在输入区确认面板中操作。');
    expect(html).not.toMatch(/允许执行|批准并继续|>拒绝<|tool-approval-card/);
  });
});
