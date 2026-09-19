const WORKSPACE_FILE_PREVIEW_EVENT = "ksadk-workspace-file-preview";

/** Request the host app to show the workspace file preview modal. */
export function openWorkspaceFilePreview(path: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_PREVIEW_EVENT, { detail: { path } }));
}

export function onWorkspaceFilePreviewRequest(handler: (path: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ path?: string }>).detail;
    handler(detail?.path ? detail.path : null);
  };
  window.addEventListener(WORKSPACE_FILE_PREVIEW_EVENT, handle);
  return () => window.removeEventListener(WORKSPACE_FILE_PREVIEW_EVENT, handle);
}
