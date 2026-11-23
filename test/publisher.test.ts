import { expect } from "chai";
import sinon, { match } from "sinon";
import { CachedMetadata } from "src/interfaces";
import Publisher from "src/publisher";
import GitHubGateway, { parseRepo } from "src/github-gateway";
import {
  createGatewayStubWithDefaults,
  createPublisher,
  defaultPublishResult,
  FakeApp,
  FakeFile,
  FakeMetadataCache,
  GatewayStub,
} from "./fakes";
import { FakeGitHub } from "./fake-github";
import { compileMdx } from "./mdx-compile";

const TARGET = "open-lakehouse/openlakehouse-io";

const frontmatterOf = (mdx: string) => mdx.substring(0, mdx.indexOf("\n---\n", 4) + 4);
const bodyOf = (mdx: string) => mdx.substring(mdx.indexOf("\n---\n", 4) + 5).trim();

describe("Publisher", () => {
  let app: FakeApp;
  let gateway: GatewayStub;
  let publisher: Publisher<FakeFile>;

  const note = (contents: string, frontmatter: FakeFile["frontmatter"] = {}, path?: string) =>
    app.fileManager.createFakeFile({ contents, frontmatter, ...(path && { path }) });

  const image = (path: string, bytes = [1, 2, 3]) =>
    app.fileManager.createFakeFile({ path, binary: new Uint8Array(bytes) });

  beforeEach(() => {
    app = new FakeApp();
    gateway = createGatewayStubWithDefaults();
    publisher = createPublisher(app, gateway);
  });

  describe("Title", () => {
    it("uses the first H1 and removes it (and any preamble) from the body", async () => {
      const file = note("Preamble\n\n# My Title\n\nBody text");
      const post = await publisher.generatePost(file);
      expect(post.title).to.equal("My Title");
      expect(bodyOf(post.mdx)).to.equal("Body text");
    });

    it("prefers frontmatter `title`, keeping a different H1 in the body", async () => {
      const contents = "---\ntitle: FM title\n---\n# Section\n\nBody";
      const file = note(contents, { title: "FM title" });
      const post = await publisher.generatePost(file);
      expect(post.title).to.equal("FM title");
      expect(bodyOf(post.mdx)).to.equal("# Section\n\nBody");
    });

    it("removes an H1 identical to the frontmatter title", async () => {
      const file = note("---\ntitle: Same\n---\n# Same\n\nBody", { title: "Same" });
      expect(bodyOf((await publisher.generatePost(file)).mdx)).to.equal("Body");
    });

    it("falls back to the file name", async () => {
      const file = note("Body", {}, "notes/My Note.md");
      expect((await publisher.generatePost(file)).title).to.equal("My Note");
    });
  });

  describe("Frontmatter generation", () => {
    it("generates the openlakehouse schema with defaults", async () => {
      const file = note("# Hello World\n\nFirst paragraph here.\n\nSecond.", {}, "Hello World.md");
      const post = await publisher.generatePost(file);
      expect(post.category).to.equal("iceberg");
      expect(post.slug).to.equal("hello-world");
      expect(post.directory).to.equal("src/content/posts/iceberg/hello-world");
      expect(frontmatterOf(post.mdx)).to.equal(
        [
          "---",
          'title: "Hello World"',
          "date: 2026-11-23",
          "authors: [scott-haines]",
          'excerpt: "First paragraph here."',
          "tags: []",
          "include: [blog]",
          "kind: post",
          "---",
        ].join("\n"),
      );
    });

    it("maps `ol-*` and plain keys, with `ol-*` taking precedence", async () => {
      const file = note("# T\n\nBody", {
        "ol-category": "Delta Lake",
        slug: "Custom Slug",
        "ol-subtitle": "A deck",
        date: "2026-01-02T10:00:00",
        "ol-authors": ["lisa-cao", "zheng-hu"],
        authors: ["ignored"],
        excerpt: "An excerpt",
        tags: ["#spark", "delta-lake"],
        "ol-include": ["blog", "learn"],
        kind: "tutorial",
        "ol-status": "preview",
        "ol-thumbnail": "https://cdn.example.com/og.png",
        readingTime: 7,
        originalUrl: "https://delta.io/blog/x",
        "ol-originalPublisher": "Delta Lake",
        // Obsidian-only keys are dropped
        aliases: ["foo"],
        cssclasses: ["wide"],
        publish: true,
      });
      const post = await publisher.generatePost(file);
      expect(post.category).to.equal("delta-lake");
      expect(post.slug).to.equal("custom-slug");
      expect(frontmatterOf(post.mdx)).to.equal(
        [
          "---",
          'title: "T"',
          'subtitle: "A deck"',
          "date: 2026-01-02",
          "authors: [lisa-cao, zheng-hu]",
          'excerpt: "An excerpt"',
          "tags: [spark, delta-lake]",
          "include: [blog, learn]",
          "kind: tutorial",
          "status: preview",
          'thumbnail: "https://cdn.example.com/og.png"',
          "readingTime: 7",
          'originalUrl: "https://delta.io/blog/x"',
          'originalPublisher: "Delta Lake"',
          "---",
        ].join("\n"),
      );
    });

    it("accepts a single `author` and comma separated tags", async () => {
      const file = note("Body", { author: "ben-fleis", tags: "a, b" });
      const fm = frontmatterOf((await publisher.generatePost(file)).mdx);
      expect(fm).to.contain("authors: [ben-fleis]");
      expect(fm).to.contain("tags: [a, b]");
    });

    it("keeps slug and category from `ol-path` on re-publish", async () => {
      const file = note("Body", {
        "ol-path": "src/content/posts/agentic/original-slug/index.mdx",
      }, "Renamed note.md");
      const post = await publisher.generatePost(file);
      expect(post.directory).to.equal("src/content/posts/agentic/original-slug");
    });

    it("rejects invalid enum values", async () => {
      await publisher.generatePost(note("Body", { kind: "essay" })).should.be.rejectedWith("Invalid kind");
      await publisher.generatePost(note("Body", { status: "live" })).should.be.rejectedWith("Invalid status");
      await publisher.generatePost(note("Body", { include: ["home"] })).should.be.rejectedWith("Invalid include");
    });

    it("requires a category and authors", async () => {
      const p = createPublisher(app, gateway, { defaultCategory: "", defaultAuthors: [] });
      await p.generatePost(note("Body", { "ol-authors": ["x"] })).should.be.rejectedWith("No category");
      await p.generatePost(note("Body", { "ol-category": "x" })).should.be.rejectedWith("No authors");
    });
  });

  describe("Links", () => {
    beforeEach(() => {
      // Simulates https://github.com/obsidianmd/obsidian-api/issues/166 (links reported twice)
      sinon.stub(app.metadataCache, "getFileCache").callsFake(function (this: FakeMetadataCache, file) {
        const result: CachedMetadata = FakeMetadataCache.prototype.getFileCache.bind(this)(file);
        return result.links ? { ...result, links: [...result.links, ...result.links] } : result;
      });
    });

    it("links notes that have been published to their site URL; others become plain text", async () => {
      const file = note("Line1: [[File1]]\nLine2: [[File2|alias]]\nLine3: [[File3#Heading]]");
      const published = note("", { "ol-path": "src/content/posts/iceberg/file-one/index.mdx" });
      const unpublished = note("");
      app.metadataCache.setLinkTarget("File1", file.path, published);
      app.metadataCache.setLinkTarget("File2", file.path, unpublished);
      app.metadataCache.setLinkTarget("File3", file.path, published);
      expect(await publisher.generateMarkdown(file)).to.equal(
        [
          "Line1: [File1](https://openlakehouse.io/blog/iceberg/file-one)",
          "Line2: alias",
          "Line3: [File3#Heading](https://openlakehouse.io/blog/iceberg/file-one)",
        ].join("\n"),
      );
    });

    it("plays nice with title replacement", async () => {
      const file = note("Line1: [[File1]]\n\n# Heading\n\nLine2: [[File2]]\nLine3: [[File3]]");
      expect(await publisher.generateMarkdown(file)).to.equal("Line2: File2\nLine3: File3");
    });

    it("uses the configured site URL", async () => {
      const p = createPublisher(app, gateway, { siteUrl: "https://preview.example.com/" });
      const file = note("[[A]]");
      app.metadataCache.setLinkTarget("A", file.path, note("", { "ol-path": "src/content/posts/x/a/index.mdx" }));
      expect(await p.generateMarkdown(file)).to.equal("[A](https://preview.example.com/blog/x/a)");
    });
  });

  describe("Images", () => {
    it("uploads wikilink and markdown embeds co-located and rewrites them to imports", async () => {
      const file = note(
        "A ![[Diagram 1.png]] and ![Alt text](assets/photo.JPG) and ![[Diagram 1.png|300]] and ![remote](https://x.com/a.png)",
      );
      const diagram = image("attachments/Diagram 1.png");
      const photo = image("assets/photo.JPG");
      app.metadataCache.setLinkTarget("Diagram 1.png", file.path, diagram);
      app.metadataCache.setLinkTarget("assets/photo.JPG", file.path, photo);

      const post = await publisher.generatePost(file);
      expect(post.assets.map((a) => [a.fileName, a.file])).to.deep.equal([
        ["diagram-1.png", diagram],
        ["photo.jpg", photo],
      ]);
      expect(bodyOf(post.mdx)).to.equal(
        [
          'import img0 from "./diagram-1.png";',
          'import img1 from "./photo.jpg";',
          "",
          'A <img src={img0} alt="Diagram 1" /> and <img src={img1} alt="Alt text" /> and <img src={img0} alt="Diagram 1" /> and ![remote](https://x.com/a.png)',
        ].join("\n"),
      );
    });

    it("decodes URL-encoded markdown image paths", async () => {
      const file = note("![x](my%20pic.png)");
      app.metadataCache.setLinkTarget("my pic.png", file.path, image("my pic.png"));
      const post = await publisher.generatePost(file);
      expect(post.assets[0].fileName).to.equal("my-pic.png");
    });

    it("de-duplicates file names and never shadows thumbnail.*", async () => {
      const file = note("![[a/pic.png]] ![[b/pic.png]] ![[thumbnail.png]]");
      app.metadataCache.setLinkTarget("a/pic.png", file.path, image("a/pic.png"));
      app.metadataCache.setLinkTarget("b/pic.png", file.path, image("b/pic.png"));
      app.metadataCache.setLinkTarget("thumbnail.png", file.path, image("thumbnail.png"));
      const post = await publisher.generatePost(file);
      expect(post.assets.map((a) => a.fileName)).to.deep.equal([
        "pic.png",
        "pic-2.png",
        "image-thumbnail.png",
      ]);
    });

    it("uploads a vault thumbnail as co-located thumbnail.<ext> without a frontmatter key", async () => {
      const file = note("Body", { "ol-thumbnail": "[[Cover.webp]]" });
      const cover = image("Cover.webp");
      app.metadataCache.setLinkTarget("Cover.webp", file.path, cover);
      const post = await publisher.generatePost(file);
      expect(post.assets).to.deep.equal([{ fileName: "thumbnail.webp", file: cover }]);
      expect(frontmatterOf(post.mdx)).not.to.contain("thumbnail");
    });

    it("escapes quotes in alt text", async () => {
      const file = note('![[x.png|Say "hi" {now}]]');
      app.metadataCache.setLinkTarget("x.png", file.path, image("x.png"));
      expect(bodyOf((await publisher.generatePost(file)).mdx)).to.contain(
        'alt={"Say \\"hi\\" {now}"}',
      );
    });

    it("fails if an embedded image is missing", async () => {
      await publisher.generatePost(note("![[missing.png]]")).should.be.rejectedWith(
        "Embedded image not found in vault: missing.png",
      );
    });

    it("turns non-image embeds into links", async () => {
      expect(await publisher.generateMarkdown(note("![[Other note]]"))).to.equal("Other note");
    });
  });

  describe("Body transformation", () => {
    it("strips comments, converts callouts, rewrites autolinks and escapes MDX", async () => {
      const file = note(
        [
          "---",
          "foo: {bar}",
          "---",
          "Intro {braces} and a < b %%hidden%%",
          "",
          "> [!note] Heads up",
          "> Inside <callout>",
          "",
          "See <https://openlakehouse.io>.",
          "",
          "Inline `{code} <x>` stays.",
          "",
          "```python",
          "d = {'a': 1}  # %%not a comment%%",
          "```",
        ].join("\n"),
        { foo: "{bar}" },
      );
      expect(await publisher.generateMarkdown(file)).to.equal(
        [
          "Intro \\{braces\\} and a &lt; b",
          "",
          "> **Heads up**",
          "> Inside &lt;callout>",
          "",
          "See [https://openlakehouse.io](https://openlakehouse.io).",
          "",
          "Inline `{code} <x>` stays.",
          "",
          "```python",
          "d = {'a': 1}  # %%not a comment%%",
          "```",
        ].join("\n"),
      );
    });
  });

  describe("publish()", () => {
    it("creates: sends index.mdx and images to the gateway and writes back frontmatter", async () => {
      const file = note("# Post\n\n![[pic.png]]", {}, "Post.md");
      app.metadataCache.setLinkTarget("pic.png", file.path, image("pic.png", [9, 8, 7]));
      gateway.publishPost.resolves(
        defaultPublishResult({
          branch: "obsidian/post",
          pullRequestNumber: 42,
          pullRequestUrl: `https://github.com/${TARGET}/pull/42`,
        }),
      );
      await publisher.publish(file);

      gateway.publishPost.should.have.been.calledOnceWith(
        match({
          branch: "obsidian/post",
          title: "Post",
          previousPullRequestNumber: undefined,
        }),
      );
      const { files } = gateway.publishPost.firstCall.args[0];
      expect(files.map((f) => f.path)).to.deep.equal([
        "src/content/posts/iceberg/post/index.mdx",
        "src/content/posts/iceberg/post/pic.png",
      ]);
      expect(typeof files[0].content).to.equal("string");
      expect([...new Uint8Array(files[1].content as ArrayBuffer)]).to.deep.equal([9, 8, 7]);

      expect(file.frontmatter).to.deep.equal({
        "ol-path": "src/content/posts/iceberg/post/index.mdx",
        "ol-branch": "obsidian/post",
        "ol-pr-url": `https://github.com/${TARGET}/pull/42`,
        "ol-pr-number": 42,
        "ol-date": "2026-11-23",
      });
    });

    it("updates: reuses the stored branch and PR number and keeps the pinned date", async () => {
      const file = note("Body", {
        "ol-path": "src/content/posts/iceberg/post/index.mdx",
        "ol-branch": "obsidian/post",
        "ol-pr-number": 42,
        "ol-date": "2026-10-01",
      });
      await publisher.publish(file);
      gateway.publishPost.should.have.been.calledOnceWith(
        match({ branch: "obsidian/post", previousPullRequestNumber: 42 }),
      );
      const mdx = gateway.publishPost.firstCall.args[0].files[0].content as string;
      expect(mdx).to.contain("date: 2026-10-01");
      expect(file.frontmatter["ol-date"]).to.equal("2026-10-01");
    });

    it("does not write back frontmatter when publishing fails", async () => {
      const file = note("Body");
      gateway.publishPost.rejects(new Error("boom"));
      await publisher.publish(file).should.be.rejectedWith("boom");
      expect(file.frontmatter).to.deep.equal({});
    });
  });

  describe("End-to-end against a fake GitHub", () => {
    it("creates the branch + PR on first run and updates the same branch/PR on re-run", async () => {
      const github = new FakeGitHub();
      github.addRepo(TARGET);
      const gw = new GitHubGateway(
        { token: github.token, targetRepo: parseRepo(TARGET)!, baseBranch: "main" },
        github.requestUrl,
      );
      const p = createPublisher(app, gw);
      const file = note("# E2E\n\nVersion 1 ![[pic.png]]", {}, "E2E.md");
      app.metadataCache.setLinkTarget("pic.png", file.path, image("pic.png"));

      await p.publish(file);
      const prUrl = file.frontmatter["ol-pr-url"];
      expect(file.frontmatter["ol-branch"]).to.equal("obsidian/e2e");
      expect(github.fileText(TARGET, "obsidian/e2e", "src/content/posts/iceberg/e2e/index.mdx")).to.contain("Version 1");
      expect(github.file(TARGET, "obsidian/e2e", "src/content/posts/iceberg/e2e/pic.png")).to.exist;

      file.contents = "# E2E\n\nVersion 2 ![[pic.png]]";
      github.requests = [];
      await p.publish(file);
      expect(file.frontmatter["ol-pr-url"]).to.equal(prUrl);
      expect(github.pulls[TARGET]).to.have.length(1);
      expect(github.fileText(TARGET, "obsidian/e2e", "src/content/posts/iceberg/e2e/index.mdx")).to.contain("Version 2");
      // Only the changed index.mdx is written; the unchanged image is skipped
      expect(github.requestsMatching("PUT", `/repos/${TARGET}/contents/`)).to.have.length(1);
      expect(github.requestsMatching("POST", `/repos/${TARGET}/git/refs`)).to.be.empty;
    });
  });

  describe("Generated MDX compiles with @mdx-js/mdx", () => {
    it("compiles a note using every supported Obsidian feature", async () => {
      const file = note(
        [
          "---",
          'title: "Kitchen sink: {all} <the> things"',
          "tags: [a, b]",
          "aliases: [x]",
          "---",
          "# Ignored H1? no - different from title",
          "",
          "Text with {braces}, a < b, x > y, 5 <= 6 and an <unclosed tag.",
          "Comment %%hidden {x}%% here. <!-- html comment -->",
          "Link to [[Published]] and [[Unpublished|alias {x}]] and <https://example.com>.",
          "",
          "> [!warning]- Careful {x}",
          "> Inside a callout with <html>",
          "> > [!note]",
          "> > nested",
          "",
          "![[pic one.png|An image]]",
          "![md image](pic%20one.png)",
          "![remote](https://example.com/a.png)",
          "",
          "| a | b |",
          "|---|---|",
          "| {1} | <2> |",
          "",
          "- [ ] task {x}",
          "- [x] done",
          "",
          "Inline `const x = {a: 1} <T>` code.",
          "",
          "```tsx",
          "const Comp = () => <div>{value}</div>;",
          "```",
          "",
          "    indented {not code in MDX}",
          "",
          "$$",
          "x^{2}",
          "$$",
          "",
          "Final line with $inline {math}$ and a trailing {",
        ].join("\n"),
        { title: "Kitchen sink: {all} <the> things", tags: ["a", "b"], aliases: ["x"] },
      );
      app.metadataCache.setLinkTarget(
        "Published",
        file.path,
        note("", { "ol-path": "src/content/posts/iceberg/published/index.mdx" }),
      );
      app.metadataCache.setLinkTarget("pic one.png", file.path, image("pic one.png"));

      const post = await publisher.generatePost(file);
      expect(post.mdx).to.contain('title: "Kitchen sink: {all} <the> things"');
      expect(post.mdx).not.to.contain("aliases");
      expect(post.mdx).not.to.contain("hidden");
      const compiled = await compileMdx(post.mdx);
      expect(compiled).to.contain('import img0 from "./pic-one.png"');
      expect(compiled).to.contain("https://openlakehouse.io/blog/iceberg/published");
    });

    it("would fail to compile the raw note (sanity check of the compile helper)", async () => {
      await compileMdx("Text with {unbalanced and <unclosed tag.").should.be.rejected;
    });
  });
});
