import { useEffect, useState } from "react";
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

  // Self-contained inline styles: this modal renders inside embedded Core
  // pages whose Tailwind build does not include the preview's utility
  // classes, so it must not depend on host-provided CSS at all.
  const bodyStyle: React.CSSProperties = {
    minHeight: 0,
    flex: "1 1 auto",
    overflow: "auto",
    padding: "16px 20px",
    fontSize: 14,
    lineHeight: 1.65,
    color: "#1f2937",
  };

  return (
    <div style={bodyStyle}>
      {state.busy && (
        <p role="status" style={{ display: "flex", alignItems: "center", gap: 8, color: "#6b7280", fontSize: 13 }}>
          <span
            aria-hidden
            style={{
              width: 15, height: 15, borderRadius: "50%",
              border: "2px solid #d1d5db", borderTopColor: "#0091ea",
              display: "inline-block", animation: "ksadk-fp-spin 0.8s linear infinite",
            }}
          />
          正在加载文件…
          <style>{`@keyframes ksadk-fp-spin { to { transform: rotate(360deg); } }`}</style>
        </p>
      )}
      {!state.busy && state.error && (
        <p role="alert" style={{ margin: 0, color: "#b91c1c", fontSize: 13 }}>
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
          style={{ display: "block", maxWidth: "100%", margin: "0 auto", borderRadius: 8 }}
        />
      )}
      {!state.busy && !state.error && payload?.mediaCategory === "text" && (
        <pre
          style={{
            overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
            background: "#f6f8fa", padding: 12, borderRadius: 8, margin: 0,
            fontSize: 13, lineHeight: 1.6, color: "#1f2937",
          }}
        >
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

const iconButtonStyle: React.CSSProperties = {
  width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", padding: 0,
  color: "#374151", flex: "0 0 auto",
};

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
      role="dialog"
      aria-modal="true"
      aria-label={`文件预览 ${title}`}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 2147483000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(15, 23, 42, 0.5)", padding: 24,
        fontFamily: '-apple-system, system-ui, "SF Pro SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          display: "flex", flexDirection: "column",
          width: "100%", maxWidth: 760, maxHeight: "100%",
          overflow: "hidden", background: "#ffffff", color: "#1f2937",
          border: "1px solid #e5e7eb", borderRadius: 12,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
        }}
      >
        <header
          style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 16px", borderBottom: "1px solid #e5e7eb", flex: "0 0 auto",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 500, color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {path}
            </p>
          </div>
          <button
            type="button"
            aria-label="下载文件"
            style={iconButtonStyle}
            onClick={() => void downloadWorkspaceFile(path, title)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button type="button" aria-label="关闭预览" style={iconButtonStyle} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
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
