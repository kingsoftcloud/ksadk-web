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
  serializedMessages,
}: {
  surfaceId: string;
  serializedMessages: string;
}) {
  const { processMessages } = useA2UI();

  useEffect(() => {
    processMessages(JSON.parse(serializedMessages) as Array<Record<string, unknown>>);
  }, [serializedMessages, processMessages]);

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
  // Canonical snapshots contain the full reduced A2UI item on every update.
  // Reprocessing an unchanged createSurface batch makes the renderer reject
  // the replay as "Surface already exists". Key the provider by the passive
  // operation batch: identical snapshots keep their state without rerunning,
  // while an append/replace batch starts from a clean catalog state and safely
  // replays the new full snapshot.
  const serializedMessages = JSON.stringify(messages);
  return (
    <div className="mb-3 w-full overflow-hidden rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <A2UIProvider
        key={`${surfaceId}:${serializedMessages}`}
        catalog={ksadkA2uiCatalog}
        onAction={onAction}
      >
        <ActivitySurface
          surfaceId={surfaceId}
          serializedMessages={serializedMessages}
        />
      </A2UIProvider>
    </div>
  );
}
