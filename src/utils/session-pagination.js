export function mergeLoadedPages(current = new Set(), pages = []) {
  const bucket = new Set(current);
  for (const page of pages) {
    const safe = Number(page);
    if (Number.isFinite(safe) && safe > 0) {
      bucket.add(safe);
    }
  }
  return new Set(Array.from(bucket).sort((left, right) => left - right));
}

export function buildSessionPaginationState({
  sessionsLength = 0,
  total = 0,
  page = 0,
  pageSize = 30,
  loadedPages = new Set(),
} = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeSessionsLength = Math.max(0, Number(sessionsLength) || 0);
  const safePage = Math.max(0, Number(page) || 0);
  const safePageSize = Math.max(1, Number(pageSize) || 30);

  return {
    total: safeTotal,
    page: safePage,
    pageSize: safePageSize,
    loadedPages: mergeLoadedPages(loadedPages),
    hasMore: safeSessionsLength < safeTotal,
  };
}

export function resolveNextSessionsPage({
  total = 0,
  pageSize = 30,
  loadedPages = new Set(),
} = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safePageSize = Math.max(1, Number(pageSize) || 30);
  if (safeTotal <= 0) {
    return null;
  }
  const totalPages = Math.ceil(safeTotal / safePageSize);
  for (let page = 1; page <= totalPages; page += 1) {
    if (!loadedPages.has(page)) {
      return page;
    }
  }
  return null;
}
