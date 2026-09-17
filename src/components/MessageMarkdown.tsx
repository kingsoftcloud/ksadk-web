import React, { Suspense, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { preprocessMarkdown } from '../utils/markdown.js';
import { rehypeWorkspaceFilePaths } from '../utils/workspace-file-paths.js';
import { openWorkspaceFilePreview } from '../utils/workspace-file-preview-bus.js';

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
type MarkdownImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

/** Markdown content can come from tools or remote agents. Only navigation
 * protocols are allowed; javascript:, data: and vbscript: must never reach
 * an anchor because the content is untrusted. */
function safeMarkdownHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const protocol = new URL(href, typeof window === 'undefined' ? 'http://localhost/' : window.location.href).protocol.toLowerCase();
    return ['http:', 'https:', 'mailto:'].includes(protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function safeMarkdownImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  try {
    const protocol = new URL(src, typeof window === 'undefined' ? 'http://localhost/' : window.location.href).protocol.toLowerCase();
    return ['http:', 'https:'].includes(protocol) ? src : undefined;
  } catch {
    return undefined;
  }
}

function MarkdownImage({ src, alt, ...props }: MarkdownImageProps) {
  const safeSrc = safeMarkdownImageSrc(src);
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>(safeSrc ? 'loading' : 'error');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  if (!safeSrc || state === 'error') {
    return <span role="img" aria-label={alt || '图片无法加载'} className="my-2 inline-flex rounded-md border border-border bg-muted px-3 py-2 text-xs text-text-secondary">{alt || '图片无法加载'}</span>;
  }
  return (
    <figure className="my-3 max-w-full">
      <a href={safeSrc} target="_blank" rel="noopener noreferrer" title="查看原图">
        <img
          {...props}
          src={safeSrc}
          alt={alt || '图片'}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            setState('loaded');
            setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
          }}
          onError={() => setState('error')}
          className="max-h-[28rem] max-w-full cursor-zoom-in rounded-lg border border-border object-contain shadow-sm"
        />
      </a>
      <figcaption className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
        <span>{state === 'loading' ? '图片加载中…' : '点击查看原图'}</span>
        {dimensions ? <span aria-label="图片尺寸">· {dimensions.width} × {dimensions.height}</span> : null}
        <a href={safeSrc} download target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">下载</a>
      </figcaption>
    </figure>
  );
}

const markdownComponents = {
  h1({ children }: { children?: React.ReactNode }) {
    return <h1 className="mb-3.5 mt-5 text-[17px] font-semibold text-foreground">{children}</h1>;
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="mb-2.5 mt-4.5 text-[15px] font-semibold text-foreground">{children}</h2>;
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h3 className="mb-2 mt-3.5 text-[14px] font-semibold text-foreground">{children}</h3>;
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-2.5 min-w-0 break-words leading-[1.65] text-foreground">{children}</p>;
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
        <code className="break-all font-mono text-[0.92em] text-text-primary before:content-none after:content-none" {...props}>
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
      <div className="mb-3 max-w-full overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] table-auto border-collapse text-sm text-foreground" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: MarkdownCellProps) {
    return <th className="break-words border-b border-border bg-muted/40 px-3 py-2 text-left align-top font-semibold text-foreground" {...props}>{children}</th>;
  },
  td({ children, ...props }: MarkdownDataCellProps) {
    return <td className="break-words border-b border-border px-3 py-2 align-top text-text-secondary" {...props}>{children}</td>;
  },
  a({ children, href, ...props }: MarkdownLinkProps) {
     const filePath = (props as Record<string, unknown>)['data-workspace-file'];
     if (typeof filePath === 'string' && filePath) {
       return (
         <a
           href="#"
           className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
           title={`预览 ${filePath}`}
           onClick={(event) => { event.preventDefault(); openWorkspaceFilePreview(filePath); }}
           {...props}
         >
           {children}
         </a>
       );
     }
     const safeHref = safeMarkdownHref(href);
     if (!safeHref) return <span className="text-text-secondary">{children}</span>;
     return <a href={safeHref} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  },
  img({ src, alt, ...props }: MarkdownImageProps) {
    return <MarkdownImage src={src} alt={alt} {...props} />;
  }
};

const PlainMarkdown: React.FC<{ content: string }> = React.memo(({ content }) => {
  const processedContent = preprocessMarkdown(content);

  return (
    <div className="max-w-none break-words text-[14px] leading-[1.65] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeWorkspaceFilePaths]}
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
