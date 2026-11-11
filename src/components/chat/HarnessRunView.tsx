import { useEffect, useRef, useState } from 'react';
import { HARNESS_VIEW_CONTRACT, type HarnessRunView as RunView } from '../../core/conversation/harness-view.js';

export function HarnessRunView({ view }: { view: RunView }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const sent = useRef(0);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(56);

  useEffect(() => {
    function receive(message: MessageEvent) {
      if (!frame.current || message.source !== frame.current.contentWindow || message.origin !== 'null') return;
      const value = message.data;
      if (value?.contract !== HARNESS_VIEW_CONTRACT) return;
      if (value.type === 'ready') {
        sent.current = 0;
        const scheme = getComputedStyle(document.documentElement).colorScheme;
        const theme = scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
          ? 'dark' : 'light';
        frame.current.contentWindow?.postMessage({ contract: HARNESS_VIEW_CONTRACT, type: 'theme', theme }, '*');
        setReady(true);
      } else if (value.type === 'height' && typeof value.height === 'number' && Number.isFinite(value.height)) {
        setHeight(Math.min(4000, Math.max(40, Math.ceil(value.height))));
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!ready || !frame.current?.contentWindow) return;
    const events = view.events.filter(event => event.seq > sent.current);
    if (!events.length) return;
    frame.current.contentWindow.postMessage({
      contract: HARNESS_VIEW_CONTRACT,
      type: 'events',
      runId: view.runId,
      events,
    }, '*');
    sent.current = events.at(-1)!.seq;
  }, [ready, view]);

  return (
    <iframe
      ref={frame}
      title="Harness 任务过程"
      src={`/_ksadk/harness/v1/views/${view.sha256}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height, border: 0, width: '100%', display: 'block' }}
    />
  );
}
