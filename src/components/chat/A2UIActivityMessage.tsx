import { useEffect } from 'react';
import {
  A2UIProvider,
  A2UIRenderer,
  useA2UI,
  type A2UIClientEventMessage,
} from '@copilotkit/a2ui-renderer';
import { ksadkA2uiCatalog } from '../../core/run/a2ui.js';

function ActivitySurface({
  surfaceId,
  messages,
}: {
  surfaceId: string;
  messages: Array<Record<string, unknown>>;
}) {
  const { processMessages } = useA2UI();

  useEffect(() => {
    processMessages(messages);
  }, [messages, processMessages]);

  return (
    <A2UIRenderer
      surfaceId={surfaceId}
      className="w-full"
      fallback={<div className="text-sm text-slate-500 dark:text-slate-400">界面内容暂不可用</div>}
      loadingFallback={<div className="text-sm text-slate-500 dark:text-slate-400">正在加载界面</div>}
    />
  );
}

export function A2UIActivityMessage({
  surfaceId,
  messages,
  onAction,
}: {
  surfaceId: string;
  messages: Array<Record<string, unknown>>;
  onAction?: (message: A2UIClientEventMessage) => void;
}) {
  return (
    <div className="mb-3 w-full overflow-hidden rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <A2UIProvider catalog={ksadkA2uiCatalog} onAction={onAction}>
        <ActivitySurface surfaceId={surfaceId} messages={messages} />
      </A2UIProvider>
    </div>
  );
}
