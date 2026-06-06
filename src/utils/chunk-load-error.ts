export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /loading chunk|chunkloaderror|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(message);
}
