import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageList } from '../components/chat/ChatMessageList.js';

describe('first-token waiting surface', () => {
  const props = { agentName: 'Agent', isMobile: false, activity: null, contextIndicator: null,
    scrollRef: createRef<HTMLDivElement>(), onDeleteFeedback: vi.fn(), onSubmitFeedback: vi.fn(),
    onOpenAttachmentPreview: vi.fn(), onRespondToApproval: vi.fn() };

  it('renders shimmer text instead of an empty assistant dot before output', () => {
    const html = renderToStaticMarkup(<ChatMessageList {...props} isStreaming showWaitingIndicator messages={[
      { id: 'user', role: 'user', content: '你好', timestamp: 1 },
      { id: 'pending', role: 'model', content: '', timestamp: 2, eventType: 'optimistic_assistant_placeholder' },
    ]} />);
    expect(html).toContain('waiting-thinking-text');
    expect(html).toContain('正在思考…');
    expect(html).not.toContain('waiting-generation-breathe');
  });

  it('does not show the welcome surface while a draft submission is pending', () => {
    const html = renderToStaticMarkup(<ChatMessageList {...props} isStreaming showWaitingIndicator messages={[]} emptyState={<p>欢迎</p>} />);
    expect(html).toContain('正在思考…');
    expect(html).not.toContain('欢迎');
  });
});
