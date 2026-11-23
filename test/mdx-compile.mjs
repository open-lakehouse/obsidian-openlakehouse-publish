// Plain ESM on purpose: @mdx-js/mdx and its dependencies are ESM-only, and
// must not be transpiled to CommonJS by the test runner.
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

/**
 * Compiles MDX with the same remark setup as openlakehouse.io's vite config
 * (remark-gfm + remark-frontmatter). Rejects if the MDX is invalid.
 */
export const compileMdx = async (source) =>
  String(
    await compile(source, {
      jsxRuntime: "automatic",
      remarkPlugins: [remarkGfm, remarkFrontmatter],
    }),
  );
