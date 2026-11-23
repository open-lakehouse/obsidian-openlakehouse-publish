/**
 * Loads the ESM-only MDX compiler through a native dynamic import, so the
 * CommonJS-transpiling test runner doesn't try to `require` it.
 */
export const compileMdx = async (source: string): Promise<string> => {
  const mod: { compileMdx: (s: string) => Promise<string> } = await import(
    "./mdx-compile.mjs"
  );
  return mod.compileMdx(source);
};
