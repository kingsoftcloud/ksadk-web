import React, { Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { preprocessMarkdown } from '../utils/markdown.js';

const LazyCodeBlock = React.lazy(() =>
  import('./markdown/CodeBlock.js').then((m) => ({ default: m.CodeBlock }))
);

const LazyMermaidBlock = React.lazy(() =>
  import('./markdown/MermaidBlock.js').then((m) => ({ default: m.MermaidBlock }))
);

const LazyMathMessageMarkdown = React.lazy(() =>
  import('./markdown/MathMessageMarkdown.js').then((m) => ({
    default: m.MathMessageMarkdown,
  }))
);

function hasMath(content: string): boolean {
  return /\$[^$]+\$|\$\$[^$]+\$\$/.test(content);
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
  h1({ children }: { children?: React.ReactNode }) {
    return <h1 className="mb-4 mt-6 text-lg font-semibold text-foreground">{children}</h1>;
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="mb-3 mt-5 text-base font-semibold text-foreground">{children}</h2>;
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">{children}</h3>;
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-3 min-w-0 break-words leading-6 text-foreground">{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul className="mb-3 list-disc space-y-1.5 pl-5 text-foreground">{children}</ul>;
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol className="mb-3 list-decimal space-y-1.5 pl-8 text-foreground">{children}</ol>;
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="min-w-0 break-words pl-1 leading-6 text-foreground">{children}</li>;
  },
  strong({ children }: { children?: React.ReactNode }) {
    return <strong className="font-semibold text-foreground">{children}</strong>;
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return <blockquote className="mb-3 border-l-2 border-border pl-4 text-text-secondary">{children}</blockquote>;
  },
  code({ className, children, ...props }: MarkdownCodeProps) {
    const match = /language-(\w+)/.exec(className || '');
    const rawValue = String(children ?? '');
    const isInline = !match && !rawValue.includes('\n');

    if (isInline) {
      return (
        <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[13.5px] text-text-primary before:content-none after:content-none" {...props}>
          {children}
        </code>
      );
    }

    const lang = match ? match[1] : '';

    if (lang === 'mermaid') {
      return (
        <Suspense fallback={<div className="h-32 animate-pulse rounded bg-muted" />}>
          <LazyMermaidBlock chart={rawValue} />
        </Suspense>
      );
    }

    return (
      <Suspense fallback={<pre className="p-4 text-sm">{rawValue}</pre>}>
        <LazyCodeBlock language={lang} value={rawValue} />
      </Suspense>
    );
  },
  table({ children, ...props }: MarkdownTableProps) {
    return (
      <div className="mb-3 max-w-full overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm text-foreground" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: MarkdownCellProps) {
    return <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground" {...props}>{children}</th>;
  },
  td({ children, ...props }: MarkdownDataCellProps) {
    return <td className="border-b border-border px-3 py-2 text-text-secondary" {...props}>{children}</td>;
  },
  a({ children, href, ...props }: MarkdownLinkProps) {
     return <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  }
};

const PlainMarkdown: React.FC<{ content: string }> = React.memo(({ content }) => {
  const processedContent = preprocessMarkdown(content);

  return (
    <div className="max-w-none break-words text-[15px] leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

export const MessageMarkdown: React.FC<{ content: string }> = React.memo(({ content }) => {
  if (hasMath(content)) {
    return (
      <Suspense fallback={<PlainMarkdown content={content} />}>
        <LazyMathMessageMarkdown content={content} />
      </Suspense>
    );
  }

  return <PlainMarkdown content={content} />;
});