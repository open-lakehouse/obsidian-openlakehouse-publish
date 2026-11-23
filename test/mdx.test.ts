import { expect } from "chai";
import {
  applyReplaceInstructions,
  calloutInstructions,
  commentInstructions,
  deriveExcerpt,
  escapeInstructions,
  findCodeRanges,
  safeFileName,
  slugify,
  toYamlFrontmatter,
} from "src/mdx";

const apply = (
  text: string,
  fn: (t: string, start: number, code: ReturnType<typeof findCodeRanges>) => any[],
) => applyReplaceInstructions(fn(text, 0, findCodeRanges(text)), text);

describe("MDX helpers", () => {
  describe("applyReplaceInstructions", () => {
    it("applies instructions in offset order regardless of input order", () => {
      expect(
        applyReplaceInstructions(
          [
            { from: 4, to: 5, replaceString: "B" },
            { from: 0, to: 1, replaceString: "A" },
          ],
          "a---b---",
        ),
      ).to.equal("A---B---");
    });

    it("drops instructions overlapping an earlier one, including same start offset", () => {
      expect(
        applyReplaceInstructions(
          [
            { from: 0, to: 3, replaceString: "" },
            { from: 0, to: 6, replaceString: "" },
            { from: 2, to: 4, replaceString: "X" },
          ],
          "abcdefgh",
        ),
      ).to.equal("gh");
    });
  });

  describe("findCodeRanges", () => {
    it("finds fenced blocks (``` and ~~~), including unclosed ones", () => {
      const text = "a\n```js\n{x}\n```\nb\n~~~\n<y>\n~~~\nc\n```\nopen {";
      const ranges = findCodeRanges(text);
      const covered = ranges.map((r) => text.substring(r.from, r.to));
      expect(covered).to.deep.equal([
        "```js\n{x}\n```",
        "~~~\n<y>\n~~~",
        "```\nopen {",
      ]);
    });

    it("finds inline code spans with matching backtick runs", () => {
      const text = "a `{x}` b ``c ` d`` e ` unmatched";
      const covered = findCodeRanges(text).map((r) => text.substring(r.from, r.to));
      expect(covered).to.deep.equal(["`{x}`", "``c ` d``"]);
    });
  });

  describe("escaping", () => {
    it("escapes braces and < outside code only", () => {
      const text = "Use {a} and x < y `{b} <c>`\n```\n{d} <e>\n```\nend }";
      const code = findCodeRanges(text);
      const result = applyReplaceInstructions(escapeInstructions(text, 0, code), text);
      expect(result).to.equal(
        "Use \\{a\\} and x &lt; y `{b} <c>`\n```\n{d} <e>\n```\nend \\}",
      );
    });

    it("leaves protected ranges alone", () => {
      const text = "{a}<b>";
      const result = applyReplaceInstructions(
        escapeInstructions(text, 0, [{ from: 3, to: 6 }]),
        text,
      );
      expect(result).to.equal("\\{a\\}<b>");
    });
  });

  describe("comments", () => {
    it("removes inline, multi-line and html comments", () => {
      expect(
        apply("a %%secret%% b\n%%\nmulti\nline\n%%\nc <!-- html --> d", commentInstructions),
      ).to.equal("a  b\n\nc  d");
    });

    it("removes whitespace before a comment at the end of a line", () => {
      expect(apply("text %%c%%\nnext", commentInstructions)).to.equal("text\nnext");
    });

    it("keeps %% inside code", () => {
      const text = "`%%not a comment%%` and\n```\n%%x%%\n```\nbut %%this%% is";
      expect(apply(text, commentInstructions)).to.equal(
        "`%%not a comment%%` and\n```\n%%x%%\n```\nbut  is",
      );
    });
  });

  describe("callouts", () => {
    it("converts a callout header to a bold blockquote line", () => {
      expect(apply("> [!warning] Be careful\n> Body text", calloutInstructions)).to.equal(
        "> **Be careful**\n> Body text",
      );
    });

    it("uses the callout type as title when none is given, and handles fold markers", () => {
      expect(apply("> [!NOTE]-\n> Body", calloutInstructions)).to.equal("> **Note**\n> Body");
      expect(apply("> [!tip]+ Tip {1}\n> Body", calloutInstructions)).to.equal(
        "> **Tip \\{1\\}**\n> Body",
      );
    });

    it("handles nested callouts", () => {
      expect(apply("> [!info] Outer\n> > [!todo] Inner\n> > x", calloutInstructions)).to.equal(
        "> **Outer**\n> > **Inner**\n> > x",
      );
    });

    it("ignores callout syntax in code", () => {
      const text = "```\n> [!note] x\n```";
      expect(apply(text, calloutInstructions)).to.equal(text);
    });
  });

  describe("names", () => {
    it("slugifies", () => {
      expect(slugify("Hello, Wörld! Iceberg 1.12")).to.equal("hello-world-iceberg-1-12");
    });

    it("creates safe file names", () => {
      expect(safeFileName("attachments/My Diagram (1).PNG")).to.equal("my-diagram-1.png");
      expect(safeFileName("???.png")).to.equal("image.png");
    });
  });

  describe("toYamlFrontmatter", () => {
    it("emits the site's frontmatter style", () => {
      expect(
        toYamlFrontmatter([
          ["title", 'Say "hi": a post'],
          ["date", "2026-11-23"],
          ["authors", ["scott-haines", "lisa-cao"]],
          ["tags", ["delta-lake", "Two words", "true"]],
          ["kind", "post"],
          ["readingTime", 5],
        ]),
      ).to.equal(
        [
          "---",
          'title: "Say \\"hi\\": a post"',
          "date: 2026-11-23",
          "authors: [scott-haines, lisa-cao]",
          'tags: [delta-lake, "Two words", "true"]',
          "kind: post",
          "readingTime: 5",
          "---",
        ].join("\n"),
      );
    });
  });

  describe("deriveExcerpt", () => {
    it("uses the first prose paragraph, stripped of markdown", () => {
      expect(
        deriveExcerpt('import a from "./a.png";\n\n## Heading\n\nSome **bold** [link](https://x) \\{x\\}.\n\nMore'),
      ).to.equal("Some bold link {x}.");
    });

    it("truncates long paragraphs at a word boundary", () => {
      const excerpt = deriveExcerpt("word ".repeat(100))!;
      expect(excerpt.length).to.be.at.most(160);
      expect(excerpt.endsWith("word…")).to.be.true;
    });
  });
});
