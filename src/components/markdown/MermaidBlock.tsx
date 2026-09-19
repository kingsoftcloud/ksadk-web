import React, { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
});

interface MermaidBlockProps {
  chart: string;
}

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ chart }) => {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<boolean>(false);
  const id = useId().replace(/:/g, '-');

  useEffect(() => {
    let isCancelled = false;
    const renderChart = async () => {
      try {
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        if (!isCancelled) {
          setSvg(renderedSvg);
          setError(false);
        }
      } catch {
        if (!isCancelled) {
          setError(true);
        }
      }
    };
    renderChart();
    return () => { isCancelled = true; };
  }, [chart, id]);

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-lg border border-red-200 bg-slate-100 dark:border-red-800 dark:bg-slate-800">
        <div role="alert" className="border-b border-red-200 px-4 py-2 text-xs text-red-600 dark:border-red-800 dark:text-red-300">
          Mermaid 渲染失败，已显示源码。
        </div>
        <pre className="overflow-x-auto p-4 text-sm text-slate-700 dark:text-slate-200">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className="my-4 flex justify-center bg-white dark:bg-slate-800 p-4 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};
