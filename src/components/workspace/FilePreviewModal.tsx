import { useEffect, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { MessageMarkdown } from "../MessageMarkdown.js";
import { onWorkspaceFilePreviewRequest } from "../../utils/workspace-file-preview-bus.js";

export interface WorkspaceFilePayload {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  mediaCategory: "markdown" | "image" | "text";
  content?: string;
  dataBase64?: string;
}

export type WorkspaceFileFetcher = (path: string) => Promise<Response>;

const defaultFetchFile: WorkspaceFileFetcher = (path) =>
  fetch(`/api/v1/workspace/file?path=${encodeURIComponent(path)}`, { headers: { Accept: "application/json" } });

async function downloadWorkspaceFile(path: string, name: string): Promise<void> {
  const response = await fetch(
    `/api/v1/workspace/file?path=${encodeURIComponent(path)}&download=true`,
  );
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface LoadedState {
  payload: WorkspaceFilePayload | null;
  error: string;
  busy: boolean;
}

function FilePreviewContent({
  path,
  fetchFile,
}: {
  path: string;
  fetchFile: WorkspaceFileFetcher;
}) {
  // Keyed by path, so each target starts clean; setStates only run after the
  // fetch settles (never synchronously inside the effect).
  const [state, setState] = useState<LoadedState>({ payload: null, error: "", busy: true });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchFile(path)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.message || body?.detail || `预览失败（${response.status}）`);
        }
        return body as WorkspaceFilePayload;
      })
      .then((payload) => {
        if (active) setState({ payload, error: "", busy: false });
      })
      .catch((cause) => {
        if (active && !controller.signal.aborted) {
          setState({
            payload: null,
            error: cause instanceof Error ? cause.message : "预览失败。",
            busy: false,
          });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, fetchFile]);

  const payload = state.payload;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {state.busy && (
        <p className="flex items-center gap-2 text-[13px] text-text-secondary" role="status">
          <LoaderCircle className="animate-spin" size={15} /> 正在加载文件…
        </p>
      )}
      {!state.busy && state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.busy && !state.error && payload?.mediaCategory === "markdown" && (
        <MessageMarkdown content={payload.content || ""} />
      )}
      {!state.busy && !state.error && payload?.mediaCategory === "image" && (
        <img
          src={`data:${payload.contentType};base64,${payload.dataBase64}`}
          alt={payload.name}
          className="mx-auto max-w-full rounded-lg"
        />
      )}
      {!state.busy && !state.error && payload?.mediaCategory === "text" && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-hover p-3 text-[13px] leading-[1.6] text-text">
          {payload.content}
        </pre>
      )}
    </div>
  );
}

export interface FilePreviewModalProps {
  path: string | null;
  onClose: () => void;
  fetchFile?: WorkspaceFileFetcher;
}

export function FilePreviewModal({ path, onClose, fetchFile = defaultFetchFile }: FilePreviewModalProps) {
  useEffect(() => {
    if (!path) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [path, onClose]);

  if (!path) return null;
  const title = path.split("/").pop() || path;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`文件预览 ${title}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-medium text-text">{title}</h2>
            <p className="truncate text-[12px] text-text-secondary">{path}</p>
          </div>
          <button
            type="button"
            className="icon-button secondary"
            aria-label="下载文件"
            onClick={() => void downloadWorkspaceFile(path, title)}
          >
            <Download size={16} />
          </button>
          <button type="button" className="icon-button secondary" aria-label="关闭预览" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <FilePreviewContent path={path} fetchFile={fetchFile} />
      </div>
    </div>
  );
}

/** Mount once per app; listens for openWorkspaceFilePreview requests. */
export function FilePreviewHost({ fetchFile }: { fetchFile?: WorkspaceFileFetcher }) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => onWorkspaceFilePreviewRequest(setPath), []);
  return <FilePreviewModal path={path} onClose={() => setPath(null)} fetchFile={fetchFile} />;
}
