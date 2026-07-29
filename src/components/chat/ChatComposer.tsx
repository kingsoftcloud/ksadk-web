import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from 'react';

import { ArrowUp, Paperclip, Square } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useModelStore } from '@/stores/model.js';
import type { ModelStore } from '@/stores/model.js';
import type { ApprovalPolicyCapability } from '@/types/capabilities.js';
import { normalizeThinkingMode } from '@/utils/model-options.js';

import { ContextUsageIndicator } from './ContextUsageIndicator';
import { MenuChip } from './MenuChip';
import { PermissionMenu } from './PermissionMenu';
import type { ComposerContextIndicator } from './types';

type ChatComposerProps = {
  attachments: File[];
  composerContextIndicator: ComposerContextIndicator;
  composerMaxHeight: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  input: string;
  isMobile: boolean;
  isStreaming: boolean;
  approvalEnabled?: boolean;
  approvalPolicy?: ApprovalPolicyCapability;
  queuedDrafts: Array<{ text: string; attachments: File[] }>;
  onAppendAttachments: (files: File[]) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (index: number) => void;
  onStopGeneration: () => void;
  onCancelRemote?: () => void;
  onSubmit: (text: string, attachments: File[]) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function ChatComposer({
  attachments,
  composerContextIndicator,
  composerMaxHeight,
  fileInputRef,
  input,
  isMobile,
  isStreaming,
  approvalEnabled = false,
  approvalPolicy,
  queuedDrafts,
  onAppendAttachments,
  onInputChange,
  onPaste,
  onRemoveAttachment,
  onStopGeneration,
  onCancelRemote,
  onSubmit,
  textareaRef,
}: ChatComposerProps) {
  const placeholderText = isMobile ? '发送消息...' : '发送消息…';
  const activeStopTitle = onCancelRemote ? '保留恢复点并结束本次执行' : '停止生成';

  // wework 风格:model/思考 chip 放输入框工具栏(从 model store 直读,不经 props)。
  const availableModels = useModelStore((s: ModelStore) => s.availableModels);
  const selectedModel = useModelStore((s: ModelStore) => s.selectedModel);
  const thinkingMode = useModelStore((s: ModelStore) => s.thinkingMode);
  const setSelectedModel = useModelStore((s: ModelStore) => s.setSelectedModel);
  const setThinkingMode = useModelStore((s: ModelStore) => s.setThinkingMode);
  const selectedModelLabel =
    availableModels.find((m) => m.id === selectedModel)?.display_name || selectedModel || '';
  const thinkingLabel = (mode: 'auto' | 'enabled' | 'disabled') =>
    mode === 'enabled' ? '开启思考' : mode === 'disabled' ? '关闭思考' : '思考自动';
  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      onAppendAttachments(Array.from(event.dataTransfer.files));
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isStreaming) {
      if (onCancelRemote) {
        onCancelRemote();
      } else {
        onStopGeneration();
      }
      return;
    }
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    onSubmit(text, attachments);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div className="relative z-10 flex-shrink-0 bg-background/95 px-3 py-3 backdrop-blur sm:px-4 sm:py-3">
      <div className="mx-auto w-full max-w-[64rem]">
        {queuedDrafts.length > 0 ? (
          <div className="mb-2 rounded-2xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-semibold">发送队列 · {queuedDrafts.length}</span>
              <span className="text-amber-700/75 dark:text-amber-200/75">当前回复完成后依次发送</span>
            </div>
            <div className="flex flex-col gap-1">
              {queuedDrafts.slice(0, 3).map((draft, index) => {
                const preview = draft.text.trim() || (draft.attachments.length > 0 ? '仅附件消息' : '空消息');
                return (
                  <div
                    key={`${index}-${preview}-${draft.attachments.length}`}
                    className="flex items-center gap-2 rounded-xl bg-background/70 px-2 py-1.5"
                  >
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 font-mono text-[10px] text-amber-700 dark:bg-amber-900/50 dark:text-amber-100">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-secondary">
                      {preview}
                    </span>
                    {draft.attachments.length > 0 ? (
                      <span className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/50 dark:text-amber-100">
                        {draft.attachments.length} 附件
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {queuedDrafts.length > 3 ? (
                <div className="px-2 pt-0.5 text-[11px] text-amber-700/80 dark:text-amber-200/80">
                  还有 {queuedDrafts.length - 3} 条等待发送
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* wework 风格:外层 surface+软阴影,内层 background+细边,圆角 26px */}
        <div className="relative rounded-[26px] bg-surface shadow-[0_0_0_0.5px_rgba(15,23,42,0.08),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_3px_7.5px_rgba(0,0,0,0.2)]">
          <div className="flex items-center gap-3">
            <form
              onSubmit={handleSubmit}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={handleDrop}
              className="relative flex min-h-[76px] min-w-0 flex-1 flex-col rounded-[26px] border border-border/45 bg-background px-4 pb-1.5 pt-2 transition-all focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15"
            >
              {attachments.length > 0 ? (
                <div className="mb-1.5 flex flex-wrap gap-2">
                  {attachments.map((file, index) => (
                    <div
                      key={`${file.name}-${file.size}-${index}`}
                      className={cn(
                        'group relative flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs',
                        isMobile ? 'max-w-full' : 'max-w-[14rem]',
                      )}
                    >
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-text-muted">
                        <Paperclip className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text-primary">{file.name}</span>
                        <span className="block text-[10px] text-text-muted">{formatFileSize(file.size)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(index)}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background text-text-muted shadow-sm transition hover:text-rose-500"
                        aria-label={`移除附件 ${file.name}`}
                      >
                        <span className="text-[11px] leading-none">×</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={onInputChange}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                placeholder={placeholderText}
                className={cn(
                  'custom-scrollbar max-h-[112px] min-h-[48px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0 pb-0 pt-1 text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-muted/55',
                  isMobile ? 'text-[16px]' : 'text-[14px]',
                )}
                style={{ maxHeight: `${composerMaxHeight}px`, overflowY: 'auto' }}
              />

              {/* wework 风格工具栏:左组(附件+权限+model+思考) | 右组(上下文环+发送) */}
              <div className="mt-auto flex min-h-8 items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <label
                    className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition hover:bg-muted hover:text-text-secondary"
                    title="上传附件"
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        if (event.target.files && event.target.files.length > 0) {
                          onAppendAttachments(Array.from(event.target.files));
                          event.target.value = '';
                        }
                      }}
                    />
                    <Paperclip className="h-[18px] w-[18px]" />
                  </label>

                  {approvalEnabled ? <PermissionMenu approvalPolicy={approvalPolicy} /> : null}

                  {availableModels.length > 0 ? (
                    <MenuChip
                      label={selectedModelLabel || selectedModel}
                      title={selectedModelLabel || selectedModel}
                      value={selectedModel}
                      onChange={(value) => setSelectedModel(value)}
                      options={availableModels.map((model) => ({
                        value: model.id,
                        label: model.display_name || model.id,
                      }))}
                    />
                  ) : null}

                  <MenuChip
                    label={thinkingLabel(thinkingMode)}
                    title="控制模型 thinking/reasoning 参数"
                    value={thinkingMode}
                    onChange={(value) =>
                      setThinkingMode(normalizeThinkingMode(value) as 'auto' | 'enabled' | 'disabled')
                    }
                    options={[
                      { value: 'auto', label: '思考自动' },
                      { value: 'enabled', label: '开启思考' },
                      { value: 'disabled', label: '关闭思考' },
                    ]}
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  {composerContextIndicator ? <ContextUsageIndicator indicator={composerContextIndicator} /> : null}

                  <button
                    type="submit"
                    disabled={!isStreaming && !input.trim() && attachments.length === 0}
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full transition-all',
                      isStreaming
                        ? 'bg-[#1f1f1f] text-white hover:opacity-80'
                        : input.trim() || attachments.length > 0
                          ? 'bg-[#1f1f1f] text-white hover:opacity-80'
                          : 'bg-muted text-text-muted/45',
                    )}
                    title={isStreaming ? activeStopTitle : '发送消息'}
                  >
                    {isStreaming ? <Square className="h-3.5 w-3.5 fill-current" /> : <ArrowUp className="h-[18px] w-[18px]" />}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
