import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatComposer, type ChatComposerProps } from '../components/chat/ChatComposer';

const noop = () => {};
const base: ChatComposerProps = {
  attachments: [], composerContextIndicator: null, composerMaxHeight: 200,
  fileInputRef: { current: null }, textareaRef: { current: null },
  input: '', isMobile: false, isStreaming: true, attachmentsEnabled: false,
  executionModeSupport: { plan: false, goal: false }, queuedDrafts: [],
  onAppendAttachments: noop, onInputChange: noop, onSelectExecutionMode: noop,
  onPaste: noop, onRemoveAttachment: noop, onStopGeneration: noop,
  onCancelRemote: noop, onSubmit: noop,
};

describe('cancel capability wording', () => {
  it.each([undefined, false])('does not promise a checkpoint without support (%s)', support => {
    const html = renderToStaticMarkup(<ChatComposer {...base} cancelPreservesCheckpoint={support} />);
    expect(html).toContain('title="停止生成"');
    expect(html).not.toContain('保留恢复点');
  });

  it('keeps the checkpoint action for runtimes explicitly supporting it', () => {
    const html = renderToStaticMarkup(<ChatComposer {...base} cancelPreservesCheckpoint />);
    expect(html).toContain('title="保留恢复点并结束本次执行"');
  });
});
