import { useCallback, useEffect, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { MessageMarkdown } from "../MessageMarkdown.js";

export interface WorkspaceFilePayload {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  mediaCategory: "markdown" | "image" | "text";
  content?: string;
  dataBase64?: string;
}

const WORKSPACE_FILE_PREVIEW_EVENT = "ksadk-workspace-file-preview";

/** Request the host app to show the workspace file preview modal. */
export function openWorkspaceFilePreview(path: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_PREVIEW_EVENT, { detail: { path } }));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Fetch a workspace file for preview. Same-origin by default; hosted embeds
 * can pass a custom fetcher that targets the control-plane endpoint. */
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

export interface FilePreviewModalProps {
  path: string | null;
  onClose: () => void;
  fetchFile?: WorkspaceFileFetcher;
}

export function FilePreviewModal({ path, onClose, fetchFile = defaultFetchFile }: FilePreviewModalProps) {
  const [payload, setPayload] = useState<WorkspaceFilePayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!path) {
      setPayload(null);
      setError("");
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setPayload(null);
    fetchFile(path)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.message || body?.detail || `预览失败（${response.status}）`);
        }
        setPayload(body as WorkspaceFilePayload);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "预览失败。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [path, fetchFile]);

  const handleKeydown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (!path) return;
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [path, handleKeydown]);

  if (!path) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`文件预览 ${payload?.name || path}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-medium text-text">{payload?.name || path.split("/").pop() || path}</h2>
            {payload && (
              <p className="truncate text-[12px] text-text-secondary" title={payload.path}>
                {payload.path} · {formatSize(payload.sizeBytes)}
              </p>
            )}
          </div>
          {payload && (
            <button
              type="button"
              className="icon-button secondary"
              aria-label="下载文件"
              onClick={() => void downloadWorkspaceFile(payload.path, payload.name)}
            >
              <Download size={16} />
            </button>
          )}
          <button type="button" className="icon-button secondary" aria-label="关闭预览" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {busy && (
            <p className="flex items-center gap-2 text-[13px] text-text-secondary" role="status">
              <LoaderCircle className="animate-spin" size={15} /> 正在加载文件…
            </p>
          )}
          {!busy && error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!busy && !error && payload?.mediaCategory === "markdown" && (
            <MessageMarkdown content={payload.content || ""} />
          )}
          {!busy && !error && payload?.mediaCategory === "image" && (
            <img
              src={`data:${payload.contentType};base64,${payload.dataBase64}`}
              alt={payload.name}
              className="mx-auto max-w-full rounded-lg"
            />
          )}
          {!busy && !error && payload?.mediaCategory === "text" && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-hover p-3 text-[13px] leading-[1.6] text-text">
              {payload.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mount once per app; listens for openWorkspaceFilePreview requests. */
export function FilePreviewHost({ fetchFile }: { fetchFile?: WorkspaceFileFetcher }) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) setPath(detail.path);
    };
    window.addEventListener(WORKSPACE_FILE_PREVIEW_EVENT, handle);
    return () => window.removeEventListener(WORKSPACE_FILE_PREVIEW_EVENT, handle);
  }, []);
  return <FilePreviewModal path={path} onClose={() => setPath(null)} fetchFile={fetchFile} />;
}
