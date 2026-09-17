import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { rehypeWorkspaceFilePaths, splitWorkspaceFilePaths, WORKSPACE_FILE_PATH_RE as FILE_PATH_RE } from "../utils/workspace-file-paths.js";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

function process(markdown: string): HastNode {
  const tree = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeWorkspaceFilePaths)
    .runSync(unified().use(remarkParse).use(remarkRehype).parse(markdown));
  return tree as HastNode;
}

function collectAnchors(node: HastNode): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const child of node.children || []) {
    if (child.tagName === "a" && child.properties?.["dataWorkspaceFile"]) {
      found.push(child.properties);
    }
    found.push(...collectAnchors(child));
  }
  return found;
}

describe("rehypeWorkspaceFilePaths", () => {
  it("linkifies workspace file paths in prose", () => {
    const tree = process("文件已经创建：/Users/xiayu/studio-test/AI芯片最新消息_2026年9月.md 可以查看");
    const anchors = collectAnchors(tree);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]["dataWorkspaceFile"]).toBe(
      "/Users/xiayu/studio-test/AI芯片最新消息_2026年9月.md",
    );
  });

  it("linkifies paths inside code blocks so tool output stays clickable", () => {
    const tree = process("`cat /tmp/notes.md`");
    const anchors = collectAnchors(tree);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]["dataWorkspaceFile"]).toBe("/tmp/notes.md");
  });

  it("does not linkify plain directories without extensions", () => {
    const tree = process("请查看 /etc 目录下的配置");
    expect(collectAnchors(tree)).toHaveLength(0);
  });

  it("does not rewrite existing links", () => {
    const tree = process("[报告](/tmp/report.md)");
    const anchors = collectAnchors(tree);
    expect(anchors).toHaveLength(0);
  });

  it("handles relative workspace paths", () => {
    FILE_PATH_RE.lastIndex = 0;
    expect(FILE_PATH_RE.test("./builds/output.md")).toBe(true);
    FILE_PATH_RE.lastIndex = 0;
  });
});

describe("splitWorkspaceFilePaths", () => {
  it("splits tool log text into text and file segments", () => {
    const segments = splitWorkspaceFilePaths("文件路径: /Users/xiayu/studio-test/AI芯片最新消息_2026年9月.md 已创建");
    expect(segments.filter(s => s.type === "file")).toHaveLength(1);
    expect(segments[0].type).toBe("text");
    expect(segments.at(-1)).toEqual({ type: "text", value: " 已创建" });
  });

  it("returns a single text segment when no path appears", () => {
    const segments = splitWorkspaceFilePaths("命令执行完成");
    expect(segments).toEqual([{ type: "text", value: "命令执行完成" }]);
  });
});
