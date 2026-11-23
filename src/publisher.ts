import {
  CachedMetadata,
  GenericApp,
  GenericFileManager,
  GenericVault,
  GetFrontMatterInfo,
} from "./interfaces";
import type { PublishFile, PublishGateway, PublishPostResult } from "./gateway";
import {
  FrontmatterEntry,
  Range,
  ReplaceInstruction,
  applyReplaceInstructions,
  calloutInstructions,
  commentInstructions,
  deriveExcerpt,
  escapeInstructions,
  escapeMdxText,
  safeFileName,
  slugify,
  toYamlFrontmatter,
} from "./mdx";
import { analyzeMarkdown, MarkdownImage } from "./markdown-ast";

export type JsonObject = { [key: string]: Json };
export type Json = string | number | boolean | null | Json[] | JsonObject;

/** Frontmatter keys written back to the note after publishing */
export const OL_PATH_KEY = "ol-path";
export const OL_BRANCH_KEY = "ol-branch";
export const OL_PR_URL_KEY = "ol-pr-url";
export const OL_PR_NUMBER_KEY = "ol-pr-number";
export const OL_DATE_KEY = "ol-date";
/** Every repository path uploaded by the last publish (index.mdx + images) */
export const OL_FILES_KEY = "ol-files";

export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
];

const VALID_INCLUDE = ["blog", "learn"];
const VALID_STATUS = ["published", "preview", "draft"];
const VALID_KIND = ["post", "getting-started", "deep-dive", "concept", "tutorial"];

/** Optional site keys that are passed through verbatim (see content.ts) */
const PASSTHROUGH_STRING_KEYS = [
  "video",
  "originalUrl",
  "originalPublisher",
  "externalUrl",
  "flowDiagram",
];

export type PublisherConfig = {
  /** Category used when the note has no `ol-category` */
  defaultCategory: string;
  /** Author ids (files in src/content/authors) used when the note has none */
  defaultAuthors: string[];
  /** Base URL of the site, for links between published notes */
  siteUrl: string;
  /** Directory holding the posts in the target repository */
  postsRoot: string;
  /** Injected for tests */
  today?: () => string;
};

export const DEFAULT_PUBLISHER_CONFIG: PublisherConfig = {
  defaultCategory: "",
  defaultAuthors: [],
  siteUrl: "https://openlakehouse.io",
  postsRoot: "src/content/posts",
};

export type PostAsset<TFile> = { fileName: string; file: TFile };

export type GeneratedPost<TFile> = {
  category: string;
  slug: string;
  title: string;
  /** Path of the post directory, relative to the repository root */
  directory: string;
  /** Complete index.mdx file contents */
  mdx: string;
  /** Images to co-locate with index.mdx */
  assets: PostAsset<TFile>[];
  date: string;
};

const isString = (x: unknown): x is string => typeof x === "string";

const asStringList = (value: Json | undefined): string[] | undefined => {
  if (Array.isArray(value)) {
    return value.filter(isString).map((x) => x.trim()).filter(Boolean);
  }
  if (isString(value) && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return undefined;
};

const extensionOf = (path: string) => {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
};

const basenameOf = (path: string) => {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(0, dot) : name;
};

const isImagePath = (path: string) => IMAGE_EXTENSIONS.includes(extensionOf(path));

const isRemote = (link: string) => /^[a-z][a-z0-9+.-]*:/i.test(link);

/** Strips `#heading` / `^block` subpaths from a link */
const linkPath = (link: string) => link.replace(/[#^].*$/, "");

const toIsoDate = (value: Json | undefined): string | undefined => {
  if (!isString(value) && typeof value !== "number") {
    return undefined;
  }
  const s = String(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (match) {
    return match[1];
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString().substring(0, 10);
};

const jsxString = (s: string) =>
  /["{}<>\n]/.test(s) ? `{${JSON.stringify(s)}}` : `"${s}"`;

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/** Parse the post category and slug back out of an `ol-path` value */
export const parseOlPath = (path: Json | undefined) => {
  if (!isString(path)) {
    return undefined;
  }
  const match = /posts\/([^/]+)\/([^/]+)\/index\.mdx$/.exec(path);
  return match ? { category: match[1], slug: match[2] } : undefined;
};

export default class Publisher<TFile extends { path: string }> {
  app: GenericApp<TFile>;
  fileManager: GenericFileManager<TFile>;
  gateway: PublishGateway;
  getFrontMatterInfo: GetFrontMatterInfo;
  vault: GenericVault<TFile>;
  config: PublisherConfig;

  constructor(
    app: GenericApp<TFile>,
    gateway: PublishGateway,
    getFrontMatterInfo: GetFrontMatterInfo,
    config: Partial<PublisherConfig> = {},
  ) {
    this.app = app;
    this.fileManager = app.fileManager;
    this.gateway = gateway;
    this.vault = app.vault;
    this.getFrontMatterInfo = getFrontMatterInfo;
    this.config = { ...DEFAULT_PUBLISHER_CONFIG, ...config };
  }

  getFrontMatter(file: TFile) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }

  /** Reads `ol-<key>`, falling back to the plain `<key>` */
  private fmValue(frontmatter: JsonObject, key: string): Json | undefined {
    const ol = frontmatter[`ol-${key}`];
    return ol !== undefined && ol !== null && ol !== ""
      ? ol
      : frontmatter[key] ?? undefined;
  }

  private resolveFile(link: string, file: TFile) {
    return this.app.metadataCache.getFirstLinkpathDest(
      linkPath(link),
      file.path,
    );
  }

  private siteUrlFor(target: TFile): string | undefined {
    const parsed = parseOlPath(this.getFrontMatter(target)?.[OL_PATH_KEY]);
    if (!parsed) {
      return undefined;
    }
    const base = this.config.siteUrl.replace(/\/$/, "");
    return `${base}/blog/${parsed.category}/${parsed.slug}`;
  }

  processLinks(
    file: TFile,
    cachedMetadata: CachedMetadata | null,
  ): ReplaceInstruction[] {
    const links = cachedMetadata?.links || [];
    return links.map((link) => {
      const targetFile = this.resolveFile(link.link, file);
      const url = targetFile && this.siteUrlFor(targetFile);
      const displayText = escapeMdxText(link.displayText || link.link);
      return {
        from: link.position.start.offset,
        to: link.position.end.offset,
        replaceString: url ? `[${displayText}](${url})` : displayText,
      };
    });
  }

  /**
   * Builds replace instructions for embedded images (both `![[img.png]]` and
   * `![alt](local.png)`), and collects the images to upload alongside the
   * post. Images are imported at the top of the MDX file and rendered with
   * `<img src={imgN} />`, the convention used by the site.
   */
  processImages(
    file: TFile,
    md: CachedMetadata | null,
    markdownImages: MarkdownImage[],
    reservedNames: Set<string>,
  ) {
    type Embed = { from: number; to: number; link: string; alt?: string };
    const embeds: Embed[] = (md?.embeds || []).map((e) => ({
      from: e.position.start.offset,
      to: e.position.end.offset,
      link: e.link,
      alt: e.displayText,
    }));
    for (const image of markdownImages) {
      if (embeds.some((e) => e.from === image.from) || isRemote(image.url)) {
        continue;
      }
      let link = image.url;
      try {
        link = decodeURI(image.url);
      } catch {
        // keep as written
      }
      embeds.push({ from: image.from, to: image.to, link, alt: image.alt });
    }

    const instructions: ReplaceInstruction[] = [];
    const assets: (PostAsset<TFile> & { variable: string })[] = [];
    for (const embed of embeds) {
      const target = this.resolveFile(embed.link, file);
      if (!isImagePath(embed.link) && !(target && isImagePath(target.path))) {
        // Non-image embed (e.g. a note transclusion): treat it like a link
        const url = target && this.siteUrlFor(target);
        const text = escapeMdxText(embed.alt || linkPath(embed.link));
        instructions.push({
          from: embed.from,
          to: embed.to,
          replaceString: url ? `[${text}](${url})` : text,
        });
        continue;
      }
      if (!target) {
        throw new PublishError(`Embedded image not found in vault: ${embed.link}`);
      }
      let asset = assets.find((a) => a.file.path === target.path);
      if (!asset) {
        asset = {
          file: target,
          fileName: this.uniqueName(safeFileName(target.path), reservedNames),
          variable: `img${assets.length}`,
        };
        assets.push(asset);
      }
      const alt =
        embed.alt &&
        embed.alt !== embed.link &&
        !/^\d+(x\d+)?$/.test(embed.alt.trim())
          ? embed.alt.trim()
          : basenameOf(target.path);
      instructions.push({
        from: embed.from,
        to: embed.to,
        replaceString: `<img src={${asset.variable}} alt=${jsxString(alt)} />`,
      });
    }
    return { instructions, assets };
  }

  private uniqueName(name: string, reserved: Set<string>) {
    let candidate = name;
    // A co-located thumbnail.* is picked up as the post thumbnail by the site
    if (/^thumbnail\./.test(candidate)) {
      candidate = `image-${candidate}`;
    }
    const dot = candidate.lastIndexOf(".");
    const stem = dot > 0 ? candidate.substring(0, dot) : candidate;
    const ext = dot > 0 ? candidate.substring(dot) : "";
    for (let i = 2; reserved.has(candidate) || candidate === "index.mdx"; i++) {
      candidate = `${stem}-${i}${ext}`;
    }
    reserved.add(candidate);
    return candidate;
  }

  generateTitle(file: TFile) {
    const metadata = this.app.metadataCache.getFileCache(file);
    const fm = metadata?.frontmatter || {};
    const fmTitle = this.fmValue(fm, "title");
    const h1 = metadata?.headings?.find((x) => x.level === 1);
    if (isString(fmTitle) && fmTitle.trim()) {
      return {
        title: fmTitle.trim(),
        h1: h1 && h1.heading.trim() === fmTitle.trim() ? h1 : undefined,
      };
    }
    if (h1) {
      return { title: h1.heading.trim(), h1 };
    }
    return { title: basenameOf(file.path), h1: undefined };
  }

  /** Transforms the note body into MDX (without frontmatter) */
  async generateMarkdown(file: TFile) {
    const { body } = await this.generateBody(file, new Set());
    return body;
  }

  private async generateBody(file: TFile, reservedNames: Set<string>) {
    const text = await this.vault.read(file);
    const metadata = this.app.metadataCache.getFileCache(file);
    const fmInfo = this.getFrontMatterInfo.getFrontMatterInfo(text);
    const bodyStart = fmInfo.exists ? fmInfo.contentStart : 0;
    const analysis = analyzeMarkdown(text, bodyStart);
    const { codeRanges } = analysis;

    const { h1 } = this.generateTitle(file);
    const structural: ReplaceInstruction[] = [
      // The site renders the title from frontmatter. As upstream, anything
      // before the title heading is considered preamble and dropped.
      { from: 0, to: h1 ? h1.position.end.offset : bodyStart, replaceString: "" },
    ];
    const { instructions: imageInstructions, assets } = this.processImages(
      file,
      metadata,
      analysis.images,
      reservedNames,
    );
    const instructions = [
      ...structural,
      ...commentInstructions(text, bodyStart, codeRanges),
      ...this.processLinks(file, metadata),
      ...imageInstructions,
      ...calloutInstructions(text, bodyStart, codeRanges),
      // indented code -> fenced code, <autolinks> -> [links](…)
      ...analysis.instructions,
    ];
    const protectedRanges: Range[] = [
      ...analysis.protectedRanges,
      ...instructions,
    ];
    instructions.push(...escapeInstructions(text, bodyStart, protectedRanges));

    const body = applyReplaceInstructions(instructions, text)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { body, assets };
  }

  private resolveThumbnail(
    file: TFile,
    fm: JsonObject,
  ): { url?: string; asset?: TFile } {
    const value = this.fmValue(fm, "thumbnail");
    if (!isString(value) || !value.trim()) {
      return {};
    }
    const v = value.trim();
    if (/^https?:\/\//i.test(v)) {
      return { url: v };
    }
    const link = v.replace(/^!?\[\[|\]\]$/g, "").replace(/\|.*$/, "");
    const target = this.resolveFile(link, file);
    if (!target || !isImagePath(target.path)) {
      throw new PublishError(`Thumbnail image not found in vault: ${v}`);
    }
    return { asset: target };
  }

  async generatePost(file: TFile): Promise<GeneratedPost<TFile>> {
    const fm = this.getFrontMatter(file) || {};
    const fromPath = parseOlPath(fm[OL_PATH_KEY]);

    const slugValue = this.fmValue(fm, "slug");
    const slug = slugify(
      isString(slugValue) && slugValue.trim()
        ? slugValue
        : fromPath?.slug || basenameOf(file.path),
    );
    const categoryValue = fm["ol-category"];
    const category = slugify(
      isString(categoryValue) && categoryValue.trim()
        ? categoryValue
        : fromPath?.category || this.config.defaultCategory,
    );
    if (!slug) {
      throw new PublishError("Could not derive a slug for the post");
    }
    if (!category) {
      throw new PublishError(
        "No category: set `ol-category` in the note or a default category in the plugin settings",
      );
    }

    const { title } = this.generateTitle(file);
    const reservedNames = new Set<string>(["index.mdx"]);
    const thumbnail = this.resolveThumbnail(file, fm);
    const assets: PostAsset<TFile>[] = [];
    if (thumbnail.asset) {
      const ext = extensionOf(thumbnail.asset.path);
      const name = `thumbnail.${ext}`;
      reservedNames.add(name);
      assets.push({ fileName: name, file: thumbnail.asset });
    }
    const { body, assets: bodyAssets } = await this.generateBody(
      file,
      reservedNames,
    );

    const authors =
      asStringList(this.fmValue(fm, "authors")) ||
      asStringList(this.fmValue(fm, "author")) ||
      this.config.defaultAuthors;
    if (!authors.length) {
      throw new PublishError(
        "No authors: set `ol-authors` in the note or default author ids in the plugin settings",
      );
    }
    const date =
      toIsoDate(this.fmValue(fm, "date")) ||
      (this.config.today
        ? this.config.today()
        : new Date().toISOString().substring(0, 10));

    const entries: FrontmatterEntry[] = [["title", title]];
    const subtitle = this.fmValue(fm, "subtitle");
    if (isString(subtitle) && subtitle.trim()) {
      entries.push(["subtitle", subtitle.trim()]);
    }
    entries.push(["date", date], ["authors", authors]);
    const excerptValue = this.fmValue(fm, "excerpt");
    const excerpt =
      isString(excerptValue) && excerptValue.trim()
        ? excerptValue.trim()
        : deriveExcerpt(body);
    if (excerpt) {
      entries.push(["excerpt", excerpt]);
    }
    const tags = (asStringList(this.fmValue(fm, "tags")) || []).map((t) =>
      t.replace(/^#/, ""),
    );
    entries.push(["tags", tags]);

    const include = asStringList(this.fmValue(fm, "include")) || ["blog"];
    const badInclude = include.filter((x) => !VALID_INCLUDE.includes(x));
    if (badInclude.length) {
      throw new PublishError(`Invalid include value(s): ${badInclude.join(", ")}`);
    }
    entries.push(["include", include]);

    const kind = this.fmValue(fm, "kind");
    const kindValue = isString(kind) && kind.trim() ? kind.trim() : "post";
    if (!VALID_KIND.includes(kindValue)) {
      throw new PublishError(`Invalid kind: ${kindValue}`);
    }
    entries.push(["kind", kindValue]);

    const status = this.fmValue(fm, "status");
    if (isString(status) && status.trim()) {
      if (!VALID_STATUS.includes(status.trim())) {
        throw new PublishError(`Invalid status: ${status}`);
      }
      entries.push(["status", status.trim()]);
    }
    if (thumbnail.url) {
      entries.push(["thumbnail", thumbnail.url]);
    }
    const readingTime = this.fmValue(fm, "readingTime");
    if (typeof readingTime === "number") {
      entries.push(["readingTime", readingTime]);
    }
    for (const key of PASSTHROUGH_STRING_KEYS) {
      const value = this.fmValue(fm, key);
      if (isString(value) && value.trim()) {
        entries.push([key, value.trim()]);
      }
    }

    const imports = bodyAssets.map(
      (a) => `import ${a.variable} from "./${a.fileName}";`,
    );
    const mdx = [
      toYamlFrontmatter(entries),
      ...(imports.length ? [imports.join("\n")] : []),
      body,
    ]
      .filter((x) => x !== "")
      .join("\n\n")
      .concat("\n");

    return {
      category,
      slug,
      title,
      date,
      directory: `${this.config.postsRoot.replace(/\/$/, "")}/${category}/${slug}`,
      mdx,
      assets: [
        ...assets,
        ...bodyAssets.map(({ fileName, file }) => ({ fileName, file })),
      ],
    };
  }

  async updateFrontmatter(file: TFile, newData: JsonObject) {
    await this.fileManager.processFrontMatter(file, (existing) => {
      for (const key of Object.keys(newData)) {
        existing[key] = newData[key];
      }
    });
  }

  /**
   * Paths the plugin uploaded on a previous run (recorded in `ol-files`, plus
   * the `ol-path` index.mdx) that are not part of the post any more, e.g. a
   * removed image or thumbnail, or the old location after a slug/category
   * change. Only recorded paths inside the posts directory are returned, so
   * nothing the plugin didn't upload is ever deleted.
   */
  obsoletePaths(fm: JsonObject, currentPaths: string[]): string[] {
    const recorded = [
      ...(Array.isArray(fm[OL_FILES_KEY]) ? (fm[OL_FILES_KEY] as Json[]) : []),
      fm[OL_PATH_KEY],
    ];
    const root = `${this.config.postsRoot.replace(/\/$/, "")}/`;
    const current = new Set(currentPaths);
    const result: string[] = [];
    for (const path of recorded) {
      if (
        isString(path) &&
        path.startsWith(root) &&
        !path.split("/").some((seg) => seg === ".." || seg === "." || seg === "") &&
        !current.has(path) &&
        !result.includes(path)
      ) {
        result.push(path);
      }
    }
    return result;
  }

  async publish(file: TFile): Promise<PublishPostResult> {
    const fm = this.getFrontMatter(file) || {};
    const post = await this.generatePost(file);
    const files: PublishFile[] = [
      { path: `${post.directory}/index.mdx`, content: post.mdx },
    ];
    for (const asset of post.assets) {
      files.push({
        path: `${post.directory}/${asset.fileName}`,
        content: await this.vault.readBinary(asset.file),
      });
    }
    const currentPaths = files.map((f) => f.path);
    const deletePaths = this.obsoletePaths(fm, currentPaths);
    const previousBranch = fm[OL_BRANCH_KEY];
    const previousPr = fm[OL_PR_NUMBER_KEY];
    const result = await this.gateway.publishPost({
      branch:
        isString(previousBranch) && previousBranch.trim()
          ? previousBranch.trim()
          : `obsidian/${post.slug}`,
      files,
      deletePaths,
      title: post.title,
      pullRequestBody: [
        `Adds/updates the post **${post.title}** at \`${post.directory}/index.mdx\`.`,
        "",
        `Published from Obsidian with the *Publish to OpenLakehouse* plugin.`,
      ].join("\n"),
      previousPullRequestNumber:
        typeof previousPr === "number" ? previousPr : undefined,
    });
    const update: JsonObject = {
      [OL_PATH_KEY]: `${post.directory}/index.mdx`,
      [OL_BRANCH_KEY]: result.branch,
      [OL_PR_URL_KEY]: result.pullRequestUrl,
      [OL_PR_NUMBER_KEY]: result.pullRequestNumber,
      [OL_FILES_KEY]: currentPaths,
    };
    if (!toIsoDate(this.fmValue(fm, "date"))) {
      // Pin the date so re-publishing doesn't move the post
      update[OL_DATE_KEY] = post.date;
    }
    await this.updateFrontmatter(file, update);
    return result;
  }
}
