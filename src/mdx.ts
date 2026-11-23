/**
 * Pure helpers for turning Obsidian-flavoured markdown into MDX that the
 * openlakehouse.io site (MDX 3 + remark-gfm + remark-frontmatter) can compile.
 *
 * Everything here works on plain strings and character offsets, so it plugs
 * into the replace-instruction engine in `publisher.ts`.
 */

import { analyzeMarkdown } from "./markdown-ast";

export type ReplaceInstruction = {
  from: number;
  to: number;
  replaceString: string;
};

export type Range = { from: number; to: number };

export const inRanges = (ranges: Range[], offset: number) =>
  ranges.some((r) => offset >= r.from && offset < r.to);

/**
 * Applies a set of replace instructions to `contents`. Instructions are applied
 * in order of their start offset; an instruction that overlaps one already
 * applied (e.g. a link inside a removed comment) is dropped.
 */
export const applyReplaceInstructions = (
  instructions: ReplaceInstruction[],
  contents: string,
) => {
  const sorted = [...instructions].sort(
    (a, b) => a.from - b.from || b.to - a.to,
  );
  const parts: string[] = [];
  let lastIndex = 0;
  for (const instruction of sorted) {
    if (instruction.from < lastIndex) {
      continue;
    }
    parts.push(contents.substring(lastIndex, instruction.from));
    parts.push(instruction.replaceString);
    lastIndex = instruction.to;
  }
  parts.push(contents.substring(lastIndex));
  return parts.join("");
};

/**
 * Code ranges (fenced, indented and inline code), found by actually parsing
 * the markdown, starting at `start`. Content in these ranges must not be
 * touched by text-level rewrites (comments, callouts, escaping).
 */
export const findCodeRanges = (text: string, start = 0): Range[] =>
  analyzeMarkdown(text, start).codeRanges;

/** Escapes characters that MDX would treat as JSX/expression syntax. */
export const escapeMdxText = (text: string) =>
  text.replace(/[{}<]/g, (c) => (c === "<" ? "&lt;" : `\\${c}`));

/**
 * Replace instructions escaping `{`, `}` and `<` in prose, i.e. in
 * [start, end) but not in any of the `protectedRanges`.
 */
export const escapeInstructions = (
  text: string,
  start: number,
  protectedRanges: Range[],
): ReplaceInstruction[] => {
  const result: ReplaceInstruction[] = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ((c === "{" || c === "}" || c === "<") && !inRanges(protectedRanges, i)) {
      result.push({ from: i, to: i + 1, replaceString: escapeMdxText(c) });
    }
  }
  return result;
};

/** `%%obsidian comments%%` and `<!-- html comments -->` are removed. */
export const commentInstructions = (
  text: string,
  start: number,
  codeRanges: Range[],
): ReplaceInstruction[] => {
  const result: ReplaceInstruction[] = [];
  const re = /%%[\s\S]*?%%|<!--[\s\S]*?-->/g;
  re.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (inRanges(codeRanges, match.index)) {
      // Restart just after the opening marker so that a real comment after
      // the code span is still found.
      re.lastIndex = match.index + 2;
      continue;
    }
    const to = match.index + match[0].length;
    let from = match.index;
    if (to === text.length || text[to] === "\n") {
      // Don't leave trailing whitespace (it could become a hard line break)
      while (from > start && (text[from - 1] === " " || text[from - 1] === "\t")) {
        from--;
      }
    }
    result.push({ from, to, replaceString: "" });
  }
  return result;
};

const capitalize = (s: string) =>
  s.length ? s[0].toUpperCase() + s.substring(1).toLowerCase() : s;

/**
 * Converts the header line of an Obsidian callout (`> [!note]+ Title`) into a
 * bold first line of a plain blockquote (`> **Title**`). The rest of the
 * callout is already a valid blockquote.
 */
export const calloutInstructions = (
  text: string,
  start: number,
  codeRanges: Range[],
): ReplaceInstruction[] => {
  const result: ReplaceInstruction[] = [];
  const re = /^((?:[ \t]*>[ \t]?)+)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm;
  re.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index < start || inRanges(codeRanges, match.index)) {
      continue;
    }
    const [whole, prefix, type, title] = match;
    const heading = title.trim() ? escapeMdxText(title.trim()) : capitalize(type);
    result.push({
      from: match.index,
      to: match.index + whole.length,
      replaceString: `${prefix}**${heading}**`,
    });
  }
  return result;
};

/** kebab-case slug suitable for a URL segment / directory name. */
export const slugify = (input: string) =>
  input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A safe, lower-case file name for an image co-located with a post. */
export const safeFileName = (name: string) => {
  const base = name.split("/").pop() || name;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.substring(0, dot) : base;
  const ext = dot > 0 ? base.substring(dot + 1).toLowerCase() : "";
  const safeStem = slugify(stem) || "image";
  return ext ? `${safeStem}.${ext}` : safeStem;
};

// --- YAML frontmatter emitter -------------------------------------------

export type FrontmatterValue = string | number | boolean | string[];
export type FrontmatterEntry = [string, FrontmatterValue];

const BARE_SCALAR = /^[a-z0-9][a-z0-9._-]*$/i;
const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

const yamlString = (value: string, allowBare: boolean) =>
  allowBare && BARE_SCALAR.test(value) && !YAML_RESERVED.test(value) && !/^[\d.]+$/.test(value)
    ? value
    : JSON.stringify(value);

const yamlValue = (key: string, value: FrontmatterValue) => {
  if (Array.isArray(value)) {
    return `[${value.map((v) => yamlString(v, true)).join(", ")}]`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (key === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  // Keyword-like values (kind, status) are emitted bare, like the existing
  // posts on the site; prose is always double quoted (JSON strings are valid
  // YAML double-quoted scalars).
  return yamlString(value, key === "kind" || key === "status");
};

export const toYamlFrontmatter = (entries: FrontmatterEntry[]) =>
  ["---", ...entries.map(([k, v]) => `${k}: ${yamlValue(k, v)}`), "---"].join(
    "\n",
  );

/** Derives a ~160 character plain-text excerpt from the first prose paragraph. */
export const deriveExcerpt = (mdxBody: string, maxLength = 160) => {
  const paragraphs = mdxBody.split(/\n\s*\n/);
  const paragraph = paragraphs
    .map((p) => p.trim())
    .find(
      (p) =>
        p && !/^(#|>|<|import |export |```|~~~|[-*+] |\d+\. |\||!\[|---)/.test(p),
    );
  if (!paragraph) {
    return undefined;
  }
  const text = paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\\([{}])/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  const cut = text.substring(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength / 2 ? cut.substring(0, lastSpace) : cut).replace(/[\s,.;:]+$/, "")}…`;
};
