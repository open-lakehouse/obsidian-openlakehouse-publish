import { expect } from "chai";
import { analyzeMarkdown } from "src/markdown-ast";
import { applyReplaceInstructions, escapeInstructions, findCodeRanges } from "src/mdx";
import { createPublisher, FakeApp } from "./fakes";
import { compileMdx } from "./mdx-compile";

/** Runs the parts of the pipeline owned by the markdown analysis */
const transform = (text: string) => {
  const a = analyzeMarkdown(text);
  return applyReplaceInstructions(
    [
      ...a.instructions,
      ...escapeInstructions(text, 0, [...a.protectedRanges, ...a.instructions]),
    ],
    text,
  );
};

describe("Markdown analysis (mdast based)", () => {
  describe("code detection", () => {
    it("finds fences nested in blockquotes and lists", () => {
      const text = "> ```js\n> const a = {b};\n> ```\n\n- item\n\n  ~~~\n  <x> {y}\n  ~~~\n";
      const covered = findCodeRanges(text).map((r) => text.substring(r.from, r.to));
      expect(covered).to.deep.equal([
        "```js\n> const a = {b};\n> ```",
        "~~~\n  <x> {y}\n  ~~~",
      ]);
      expect(transform(text)).to.equal(text);
    });

    it("does not treat a 4-space indented ``` as a fence opener", () => {
      const text = "Para\n\n    ```not a fence {x}\n\nAfter {y}";
      expect(transform(text)).to.equal(
        "Para\n\n````\n```not a fence {x}\n````\n\nAfter \\{y\\}",
      );
    });

    it("respects inline code across a line break", () => {
      const text = "a `b {c}\nd` e {f}";
      expect(transform(text)).to.equal("a `b {c}\nd` e \\{f\\}");
    });
  });

  describe("indented code", () => {
    it("is converted to a fenced block with its contents preserved", () => {
      const text = "Intro\n\n    const x = {a: 1};\n    if (x < 2) {}\n\n\tTabbed <y>\n\nEnd";
      expect(transform(text)).to.equal(
        "Intro\n\n```\nconst x = {a: 1};\nif (x < 2) {}\n\nTabbed <y>\n```\n\nEnd",
      );
    });

    it("keeps container prefixes inside blockquotes and lists", () => {
      expect(transform("> quote\n>\n>     code {x}\n>     more")).to.equal(
        "> quote\n>\n> ```\n> code {x}\n> more\n> ```",
      );
      expect(transform("- item\n\n      code {x}\n      more")).to.equal(
        "- item\n\n  ```\n  code {x}\n  more\n  ```",
      );
    });

    it("uses a longer fence when the code contains backticks", () => {
      expect(transform("    a ``` b")).to.equal("````\na ``` b\n````");
    });
  });

  describe("links and images", () => {
    it("leaves link and image destinations alone but escapes their text", () => {
      const text = [
        "![x {y}](<https://example.com/a b.png>)",
        '[t {x}](<https://example.com/q?a={b}> "title {t}")',
        "[plain](https://example.com/path?x={y}&z=<w>)",
        "[ref {x}][some-ref] and ![img][some-ref]",
        "",
        "[some-ref]: https://example.com/{ref} 'T {x}'",
      ].join("\n");
      expect(transform(text)).to.equal(
        [
          "![x \\{y\\}](<https://example.com/a b.png>)",
          '[t \\{x\\}](<https://example.com/q?a={b}> "title {t}")',
          "[plain](https://example.com/path?x={y}&z=<w>)",
          "[ref \\{x\\}][some-ref] and ![img][some-ref]",
          "",
          "[some-ref]: https://example.com/{ref} 'T {x}'",
        ].join("\n"),
      );
    });

    it("rewrites <autolinks> and leaves GFM literal autolinks alone", () => {
      expect(transform("<https://x.io/{a}> and https://y.io/{b} and <mailto:a@b.c>")).to.equal(
        "[https://x.io/{a}](https://x.io/{a}) and https://y.io/{b} and [a@b.c](mailto:a@b.c)",
      );
    });

    it("reports images with their destinations", () => {
      const images = analyzeMarkdown("x ![a](<my pic.png>) ![b](https://e.com/c.png)").images;
      expect(images.map((i) => [i.url, i.alt])).to.deep.equal([
        ["my pic.png", "a"],
        ["https://e.com/c.png", "b"],
      ]);
    });
  });

  describe("compiles as MDX", () => {
    it("handles nested fences, indented code and link destinations end-to-end", async () => {
      const app = new FakeApp();
      const publisher = createPublisher(app);
      const pic = app.fileManager.createFakeFile({ path: "a b.png", binary: new Uint8Array([1]) });
      const file = app.fileManager.createFakeFile({
        path: "Nested.md",
        contents: [
          "# Nested",
          "",
          "> [!example] Code in a callout",
          "> ```tsx",
          "> const C = () => <div>{x}</div>;",
          "> ```",
          "",
          "1. Step",
          "",
          "   ```python",
          "   d = {'a': 1}",
          "   ```",
          "",
          "2. Indented:",
          "",
          "       if a < b: {}",
          "",
          "Indented at top level:",
          "",
          "    <html> {x}",
          "",
          "![local](<a b.png>) ![remote {r}](<https://example.com/a b.png>)",
          "[t {x}](<https://example.com/?q={y}>) <https://example.com>",
        ].join("\n"),
      });
      app.metadataCache.setLinkTarget("a b.png", file.path, pic);
      const post = await publisher.generatePost(file);
      expect(post.mdx).to.contain("> ```tsx\n> const C = () => <div>{x}</div>;\n> ```");
      expect(post.mdx).to.contain("   ```\n   if a < b: {}\n   ```");
      expect(post.mdx).to.contain("```\n<html> {x}\n```");
      expect(post.mdx).to.contain("![remote \\{r\\}](<https://example.com/a b.png>)");
      expect(post.mdx).to.contain('<img src={img0} alt="local" />');
      await compileMdx(post.mdx);
    });
  });
});
