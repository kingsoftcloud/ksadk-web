import React, { useEffect, useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Eye, X, TextWrap, ChevronDown, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import { buildSandboxedHtml, useIframeMessageHandler } from '../../utils/sandbox.js';

interface CodeBlockProps {
  language: string;
  value: string;
}

const PREVIEWABLE_LANGS = new Set(['html', 'svg']);
const WRAPPABLE_LANGS = new Set(['markdown', 'md']);
const FOLD_THRESHOLD_LINES = 80;
const MAX_VISIBLE_LINES = 500;
const MAX_CSV_ROWS = 100;
// wrap 状态按内容 key 记忆(wework 做法),同一段代码切换会话也保留。
const wrapStateByKey = new Map<string, boolean>();
const wrapKey = (value: string) => `len:${value.length}|head:${value.slice(0, 64)}`;

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell); cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function CsvTable({ value, delimiter }: { value: string; delimiter: string }) {
  const rows = value.replace(/\r$/, '').split('\n').filter((line) => line.length > 0).map((line) => parseDelimitedLine(line, delimiter));
  const visibleRows = rows.slice(0, MAX_CSV_ROWS + 1);
  const header = visibleRows[0] || [];
  const body = visibleRows.slice(1, MAX_CSV_ROWS + 1);
  return (
    <div className="custom-scrollbar max-w-full overflow-auto bg-[#1e1e1e] p-3">
      <table className="min-w-max border-collapse text-xs text-slate-200">
        <thead><tr>{header.map((cell, index) => <th key={`h-${index}`} className="border-b border-slate-600 px-3 py-2 text-left font-semibold">{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={`r-${rowIndex}`} className="even:bg-white/[0.03]">{row.map((cell, index) => <td key={`c-${rowIndex}-${index}`} className="border-b border-slate-700/60 px-3 py-1.5 align-top">{cell}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > MAX_CSV_ROWS + 1 ? <div className="mt-2 text-xs text-slate-400">已显示前 {MAX_CSV_ROWS} 行数据，原文件共 {rows.length - 1} 行。</div> : null}
    </div>
  );
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, value }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview');
  const [expanded, setExpanded] = useState(false);
  const key = wrapKey(value);
  const [wrap, setWrap] = useState<boolean>(() => wrapStateByKey.get(key) ?? false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Set up iframe message handler at top level (Rules of Hooks).
  // When previewOpen is false, iframeRef.current is null so the handler
  // rejects all messages via source validation — safe and correct.
  useIframeMessageHandler(iframeRef);

  useEffect(() => {
    if (copyState === 'idle') {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const canToggleWrap = WRAPPABLE_LANGS.has(language.toLowerCase());
  const toggleWrap = () => {
    setWrap((prev) => {
      const next = !prev;
      wrapStateByKey.set(key, next);
      return next;
    });
  };

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(value);
    setCopyState(ok ? 'copied' : 'failed');
  };

  const handleDownload = () => {
    const normalizedLanguage = language.toLowerCase();
    const extension = normalizedLanguage === 'svg' ? 'svg' : normalizedLanguage === 'csv' ? 'csv' : normalizedLanguage === 'tsv' ? 'tsv' : 'html';
    const mimeType = extension === 'svg' ? 'image/svg+xml' : extension === 'html' ? 'text/html' : 'text/plain';
    const blob = new Blob([value], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `code-block.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const isPreviewable = PREVIEWABLE_LANGS.has(language.toLowerCase());
  const isCsv = ['csv', 'tsv'].includes(language.toLowerCase());
  const lines = String(value).replace(/\n$/, '').split('\n');
  const canFold = lines.length > FOLD_THRESHOLD_LINES;
  const visibleLines = expanded
    ? lines.slice(0, MAX_VISIBLE_LINES)
    : lines.slice(0, Math.min(FOLD_THRESHOLD_LINES, MAX_VISIBLE_LINES));
  const truncated = !isCsv && visibleLines.length < lines.length;
  const hardTruncated = lines.length > MAX_VISIBLE_LINES;
  const displayValue = visibleLines.join('\n');
  const isDiff = language.toLowerCase() === 'diff';

  const sandboxedHtml = isPreviewable ? buildSandboxedHtml(value) : '';

  return (
    <div className="my-4 rounded-lg overflow-hidden bg-[#1e1e1e] border border-slate-700/50 shadow-sm">
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#2d2d2d] text-slate-300 text-xs font-mono">
        <span className="uppercase">{language || 'text'}</span>
        <div className="flex items-center gap-3">
          {canToggleWrap && (
            <button
              type="button"
              onClick={toggleWrap}
              title={wrap ? '取消自动换行' : '自动换行'}
              className={cn('flex items-center gap-1.5 transition-colors py-1', wrap ? 'text-primary' : 'hover:text-white')}
            >
              <TextWrap className="w-3.5 h-3.5" />
            </button>
          )}
          {canFold && (
            <button
              type="button"
              onClick={() => setExpanded((previous) => !previous)}
              title={expanded ? '折叠代码' : '展开代码'}
              aria-expanded={expanded}
              className="flex items-center gap-1.5 py-1 transition-colors hover:text-white"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
              <span>{expanded ? '折叠' : '展开'}</span>
            </button>
          )}
          {isPreviewable && (
            <button
              type="button"
              onClick={() => { setPreviewMode('preview'); setPreviewOpen(true); }}
              className="flex items-center gap-1.5 hover:text-white transition-colors py-1"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Preview</span>
            </button>
          )}
          {(isPreviewable || isCsv) && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 hover:text-white transition-colors py-1"
              title="下载源文件"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="flex items-center gap-1.5 hover:text-white transition-colors py-1"
          >
            {copyState === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <div className={cn('text-[13.5px]', wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto')}>
        {isCsv ? <CsvTable value={value} delimiter={language.toLowerCase() === 'tsv' ? '\t' : ','} /> : <SyntaxHighlighter
          language={language}
          style={vscDarkPlus}
          showLineNumbers
          wrapLines={isDiff}
          lineProps={isDiff ? (lineNumber) => {
            const line = visibleLines[lineNumber - 1] || '';
            if (line.startsWith('+') && !line.startsWith('+++')) {
              return { style: { backgroundColor: 'rgba(34, 197, 94, 0.12)', display: 'block' } };
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
              return { style: { backgroundColor: 'rgba(244, 63, 94, 0.12)', display: 'block' } };
            }
            return { style: { display: 'block' } };
          } : undefined}
          lineNumberStyle={{ color: '#64748b', minWidth: '2.5em', paddingRight: '1em', userSelect: 'none' }}
          customStyle={{ margin: 0, padding: '1rem', background: 'transparent', whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
          PreTag="div"
        >
          {displayValue}
        </SyntaxHighlighter>}
        {truncated && (
          <div className="border-t border-slate-700/60 px-4 py-2 text-xs text-slate-400">
            {hardTruncated
              ? `已显示前 ${visibleLines.length} 行，文件共 ${lines.length} 行，超过单块 ${MAX_VISIBLE_LINES} 行上限。`
              : `已折叠剩余 ${lines.length - visibleLines.length} 行；点击“展开”查看完整内容。`}
          </div>
        )}
      </div>

      {/* Preview Dialog */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/80 animate-in fade-in-0"
            onClick={() => setPreviewOpen(false)}
          />
          {/* Dialog content */}
          <div className="relative z-50 flex w-full max-w-4xl flex-col rounded-lg border border-slate-700 bg-white shadow-lg duration-200 animate-in zoom-in-95 dark:bg-slate-900 sm:mx-4">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{language.toUpperCase()} Preview</span>
                <div className="flex rounded-md bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
                  <button type="button" onClick={() => setPreviewMode('preview')} className={cn('rounded px-2 py-1', previewMode === 'preview' && 'bg-white shadow-sm dark:bg-slate-700')}>预览</button>
                  <button type="button" onClick={() => setPreviewMode('source')} className={cn('rounded px-2 py-1', previewMode === 'source' && 'bg-white shadow-sm dark:bg-slate-700')}>源码</button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <X className="h-4 w-4 text-slate-500" />
                <span className="sr-only">Close</span>
              </button>
            </div>
            {/* Iframe */}
            <div className="h-[70vh] min-h-[20rem]">
              {previewMode === 'source' ? (
                <pre className="custom-scrollbar h-full overflow-auto bg-[#1e1e1e] p-4 text-xs leading-5 text-slate-200"><code>{value}</code></pre>
              ) : (
                <iframe
                  ref={iframeRef}
                  srcDoc={sandboxedHtml}
                  sandbox="allow-scripts allow-downloads"
                  title="HTML Preview"
                  className="h-full w-full border-0 bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
