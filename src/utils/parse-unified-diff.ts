export interface DiffFileSection {
  oldPath?: string;
  path: string;
  lines: string[];
}

const DIFF_HEADER_PATTERN = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/;

/** 解析 unified diff 字符串成文件分段(照抄 wework parseUnifiedDiff,纯函数)。 */
export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  const sectionsByPath = new Map<string, DiffFileSection>();
  let current: DiffFileSection | null = null;

  for (const line of diff.split('\n')) {
    const match = line.match(DIFF_HEADER_PATTERN);
    if (match) {
      const path = match[2];
      const existing = sectionsByPath.get(path);
      if (existing) {
        // Merge multiple diff blocks for the same file into a single section
        // so the file shows up once with all of its hunks.
        existing.lines.push(line);
        current = existing;
        continue;
      }
      current = {
        oldPath: match[1],
        path,
        lines: [line],
      };
      sectionsByPath.set(path, current);
      sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }

  return sections;
}

/** 统计一个文件分段的新增/删除行数(用于行尾 +N −M 标记)。 */
export function summarizeDiffSection(section: DiffFileSection): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of section.lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/** 判断 tool output 是否是 unified diff(以 diff --git 开头)。 */
export function isUnifiedDiff(text: string): boolean {
  return /^diff --git /m.test(text);
}
