import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Parents } from "mdast";
import type { Range, ReplaceInstruction } from "./mdx";

export type MarkdownImage = {
  from: number;
  to: number;
  /** Destination as written (backslash escapes resolved, not URL-decoded) */
  url: string;
  alt: string;
};

export type MarkdownAnalysis = {
  /** Fenced code, indented code and inline code */
  codeRanges: Range[];
  /**
   * Ranges that must not be MDX-escaped: code, link/image destinations,
   * reference labels, definitions and GFM literal autolinks.
   */
  protectedRanges: Range[];
  /**
   * Rewrites needed for MDX: indented code -> fenced code (MDX has no
   * indented code), `<https://…>` autolinks -> `[…](…)` (MDX has no
   * autolinks).
   */
  instructions: ReplaceInstruction[];
  images: MarkdownImage[];
};

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Index of the `]` closing the label that opens at `open` (the `[`), honouring
 * backslash escapes and nested brackets.
 */
const labelEnd = (text: string, open: number, end: number) => {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return open;
};

const lineStart = (text: string, offset: number) =>
  text.lastIndexOf("\n", offset - 1) + 1;

const longestRun = (s: string, c: string) =>
  Math.max(0, ...[...s.matchAll(new RegExp(`\\${c}+`, "g"))].map((m) => m[0].length));

/**
 * Parses `text` from `start` as CommonMark + GFM (what Obsidian renders) and
 * reports where code, links and images are, with offsets into `text`.
 */
export const analyzeMarkdown = (text: string, start = 0): MarkdownAnalysis => {
  const source = text.substring(start);
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const result: MarkdownAnalysis = {
    codeRanges: [],
    protectedRanges: [],
    instructions: [],
    images: [],
  };
  const protect = (from: number, to: number) => {
    if (to > from) {
      result.protectedRanges.push({ from, to });
    }
  };

  const visit = (node: Nodes) => {
    const pos = node.position;
    const from = pos?.start.offset !== undefined ? pos.start.offset + start : -1;
    const to = pos?.end.offset !== undefined ? pos.end.offset + start : -1;
    if (from >= 0 && to >= 0) {
      const raw = text.substring(from, to);
      switch (node.type) {
        case "code": {
          result.codeRanges.push({ from, to });
          protect(from, to);
          if (!FENCE_START.test(raw)) {
            // Indented code: MDX would parse it as prose, so fence it. Lines
            // after the first need the container prefix (list indent, `> `).
            const prefix = text.substring(lineStart(text, from), from);
            const fence = "`".repeat(Math.max(3, longestRun(node.value, "`") + 1));
            const body = node.value
              .split("\n")
              .map((line) => `${prefix}${line}`.replace(/[ \t]+$/, ""))
              .join("\n");
            result.instructions.push({
              from,
              to,
              replaceString: `${fence}\n${body}\n${prefix}${fence}`,
            });
          }
          return;
        }
        case "inlineCode":
          result.codeRanges.push({ from, to });
          protect(from, to);
          return;
        case "definition":
          protect(from, to);
          return;
        case "link":
        case "linkReference": {
          if (node.type === "link" && raw.startsWith("<")) {
            const label = node.url.replace(/^mailto:/, "");
            result.instructions.push({
              from,
              to,
              replaceString: `[${label}](${node.url})`,
            });
            return;
          }
          if (!raw.startsWith("[")) {
            // GFM literal autolink (www.example.com, https://…, a@b.c)
            protect(from, to);
            return;
          }
          // Link text is prose (escaped); `](destination "title")` / `][ref]` is not
          protect(labelEnd(text, from, to), to);
          break;
        }
        case "image":
        case "imageReference": {
          // Alt text is prose (escaped); the destination / reference is not
          protect(labelEnd(text, from + 1, to), to);
          if (node.type === "image") {
            result.images.push({ from, to, url: node.url, alt: node.alt || "" });
          }
          return;
        }
      }
    }
    if ("children" in node) {
      for (const child of (node as Parents).children) {
        visit(child);
      }
    }
  };
  visit(tree);
  result.codeRanges.sort((a, b) => a.from - b.from);
  result.protectedRanges.sort((a, b) => a.from - b.from);
  return result;
};
