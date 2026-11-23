import type { RequestUrlParam } from "obsidian";

/**
 * Minimal view of an HTTP response, compatible with Obsidian's
 * `RequestUrlResponse` (where `json` is a getter that parses the body) and
 * with the fetch-based wrapper used in tests (where `json` is a promise).
 */
export type HttpResponse = {
  status: number;
  json: unknown;
};

/** Same call signature as Obsidian's `requestUrl`, narrowed to what we use. */
export type MakeHttpRequest = (input: RequestUrlParam) => Promise<HttpResponse>;

export type PublishFile = {
  /** Repository path, e.g. `src/content/posts/iceberg/my-post/index.mdx` */
  path: string;
  /** UTF-8 text, or raw bytes for binary files (images) */
  content: string | ArrayBuffer;
};

export type PublishPostInput = {
  /** Branch on the head repository receiving the commits */
  branch: string;
  files: PublishFile[];
  /** Used for commit messages and the pull request */
  title: string;
  pullRequestBody: string;
  /** PR number written to frontmatter by a previous run, if any */
  previousPullRequestNumber?: number;
};

export type PublishPostResult = {
  /** `owner/name` of the repository holding the branch */
  headRepo: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  branchCreated: boolean;
  pullRequestCreated: boolean;
  /** Repository paths that were actually written (unchanged files are skipped) */
  filesWritten: string[];
};

/**
 * Where a post gets published. The plugin only ships a GitHub implementation,
 * but the publisher depends on this interface only.
 */
export interface PublishGateway {
  publishPost(input: PublishPostInput): Promise<PublishPostResult>;
}
