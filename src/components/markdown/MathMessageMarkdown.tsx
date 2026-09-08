import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CodeBlock } from './CodeBlock.js';
import { MermaidBlock } from './MermaidBlock.js';
import { preprocessMarkdown } from '../../utils/markdown.js';

interface MathMessageMarkdownProps {
  content: string;
}

type MarkdownCodeProps = React.HTMLAttributes<HTMLElement> & {
  className?: string;
  children?: React.ReactNode;
};

type MarkdownTableProps = React.TableHTMLAttributes<HTMLTableElement>;
type MarkdownCellProps = React.ThHTMLAttributes<HTMLTableCellElement>;
type MarkdownDataCellProps = React.TdHTMLAttributes<HTMLTableCellElement>;
type MarkdownLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>;

const markdownComponents = {
  code({ className, children, ...props }: MarkdownCodeProps) {
    const match = /language-(\w+)/.exec(className || '');
    const rawValue = String(children ?? '');
    const isInline = !match && !rawValue.includes('\n');

    if (isInline) {
      return (
        <code className="break-all font-mono text-[0.92em] text-slate-800 dark:text-slate-200 before:content-none after:content-none" {...props}>
          {children}
        </code>
      );
    }
    const lang = match ? match[1] : '';
    if (lang === 'mermaid') {
      return <MermaidBlock chart={rawValue} />;
    }
    return <CodeBlock language={lang} value={rawValue} />;
  },
  table({ children, ...props }: MarkdownTableProps) {
    return (
      <div className="my-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="my-0 w-full min-w-[36rem] table-auto text-left text-sm" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: MarkdownCellProps) {
    return <th className="break-words border-b border-slate-200 bg-slate-50 px-3 py-2 text-left align-top font-semibold dark:border-slate-700 dark:bg-slate-800/50" {...props}>{children}</th>;
  },
  td({ children, ...props }: MarkdownDataCellProps) {
    return <td className="break-words border-b border-slate-100 px-3 py-2 align-top dark:border-slate-800 last:border-0" {...props}>{children}</td>;
  },
  a({ children, href, ...props }: MarkdownLinkProps) {
     return <a href={href} className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  }
};

export const MathMessageMarkdown: React.FC<MathMessageMarkdownProps> = React.memo(({ content }) => {
  const processedContent = preprocessMarkdown(content);

  return (
    <div className="prose prose-slate dark:prose-invert max-w-none break-words text-[15px] leading-7 prose-headings:mb-3 prose-headings:mt-6 prose-headings:font-semibold prose-headings:text-slate-900 dark:prose-headings:text-slate-50 prose-h1:text-[1.95rem] prose-h1:leading-tight prose-h1:tracking-[-0.02em] prose-h2:text-[1.55rem] prose-h2:leading-tight prose-h2:tracking-[-0.015em] prose-h3:text-[1.2rem] prose-h3:leading-snug prose-p:my-3 prose-p:leading-7 prose-strong:text-slate-900 dark:prose-strong:text-slate-100 prose-ol:my-3 prose-ul:my-3 prose-li:my-1.5 prose-li:leading-7 prose-hr:my-5 prose-hr:border-slate-200 dark:prose-hr:border-slate-700 prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});
