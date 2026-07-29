/** 对齐 markdown 表格表头/分隔行列数到数据行多数列数。 */
export function alignTableColumns(text: string): string {
  if (!/(?:^|\n)\s*\|/.test(text)) return text;
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;
  const isRow = (l: string) => l.trim().startsWith('|') && l.trim().endsWith('|') && l.trim().split('|').length >= 4;
  const isSep = (l: string) => /^\s*\|(?:\s*[:-]+\s*\|){2,}\s*$/.test(l);
  const cellsOf = (l: string) => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const join = (c: string[], indentation: string) => `${indentation}| ${c.join(' | ')} |`;
  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const indentation = lines[i].match(/^(\s*)/)?.[1] || '';
      const header = cellsOf(lines[i]);
      const sep = cellsOf(lines[i + 1]);
      const data: string[][] = [];
      let j = i + 2;
      let maxCols = Math.max(header.length, sep.length);
      while (j < lines.length && isRow(lines[j])) {
        const d = cellsOf(lines[j]);
        maxCols = Math.max(maxCols, d.length);
        data.push(d);
        j += 1;
      }
      const pad = (c: string[], fill: string) => { const o = [...c]; while (o.length < maxCols) o.push(fill); return o; };
      result.push(join(pad(header, ''), indentation));
      result.push(join(pad(sep, '---'), indentation));
      for (const d of data) result.push(join(pad(d, ''), indentation));
      i = j;
    } else {
      result.push(lines[i]);
      i += 1;
    }
  }
  return result.join('\n');
}
