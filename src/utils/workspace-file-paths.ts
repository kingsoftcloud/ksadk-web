const FILE_PATH_RE = new RegExp(
  [
    // Absolute paths: /…/name.ext — CJK letters allowed, CJK punctuation and
    // whitespace terminate the match. Requires at least one directory slash
    // beyond the leading one so plain "/xx.md" hrefs stay unambiguous.
    "/(?:[^\\s`'\"()\\[\\]{}<>，。；！？、：·…]+/)+[^\\s`'\"()\\[\\]{}<>，。；！？、：·…]+\\.(?:md|markdown|txt|json|csv|tsv|log|py|js|ts|tsx|jsx|html|css|yaml|yml|toml|xml|sh|sql|go|rs|java|c|cpp|h|diff|ini|png|jpg|jpeg|gif|webp|svg|bmp|ico)",
    // Workspace-relative paths: ./name.ext or ../name.ext
    "\\.{1,2}/[^\\s`'\"()\\[\\]{}<>，。；！？、：·…]+\\.(?:md|markdown|txt|json|csv|tsv|log|py|js|ts|tsx|jsx|html|css|yaml|yml|toml|xml|sh|sql|png|jpg|jpeg|gif|webp|svg)",
  ].join("|"),
  "g",
);

// a/script/style stay skipped (no nested links, never execute); code blocks
// are linkified too — agents report created files inside tool output code.
const SKIP_ANCESTORS = new Set(["a", "script", "style", "head"]);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

function splitPathTokens(value: string): Array<HastNode> {
  const nodes: Array<HastNode> = [];
  let lastIndex = 0;
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    nodes.push({
      type: "element",
      tagName: "a",
      properties: { href: "#", "dataWorkspaceFile": match[0] },
      children: [{ type: "text", value: match[0] }],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    nodes.push({ type: "text", value: value.slice(lastIndex) });
  }
  return nodes.length ? nodes : [{ type: "text", value }];
}

/** Turn file paths appearing in markdown prose into preview links.
 * Paths inside code blocks, existing links, and headings' raw HTML are left
 * untouched so code samples keep their literal text. */
export function rehypeWorkspaceFilePaths() {
  return (tree: HastNode): void => {
    const walk = (node: HastNode, insideSkipped: boolean): void => {
      if (!node.children) return;
      const skipped = insideSkipped || SKIP_ANCESTORS.has(node.tagName || "");
      const nextChildren: Array<HastNode> = [];
      for (const child of node.children) {
        if (!skipped && child.type === "text" && typeof child.value === "string") {
          FILE_PATH_RE.lastIndex = 0;
          if (FILE_PATH_RE.test(child.value)) {
            nextChildren.push(...splitPathTokens(child.value));
            continue;
          }
        }
        walk(child, skipped);
        nextChildren.push(child);
      }
      node.children = nextChildren;
    };
    walk(tree, false);
  };
}

export const WORKSPACE_FILE_PATH_RE = FILE_PATH_RE;


export type WorkspaceFilePathSegment =
  | { type: "text"; value: string }
  | { type: "file"; value: string };

/** Split plain text (tool logs, command output) into text and file-path
 * segments so hosts can render paths as preview links outside markdown. */
export function splitWorkspaceFilePaths(value: string): WorkspaceFilePathSegment[] {
  const segments: WorkspaceFilePathSegment[] = [];
  let lastIndex = 0;
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(value))) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    segments.push({ type: "file", value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex === 0) return [{ type: "text", value }];
  if (lastIndex < value.length) {
    segments.push({ type: "text", value: value.slice(lastIndex) });
  }
  return segments;
}
