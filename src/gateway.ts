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

/** A repository path and the git blob sha of the content the plugin uploaded */
export type OwnedFile = { path: string; sha: string };

export type PublishPostInput = {
  /** Branch on the head repository receiving the commits */
  branch: string;
  files: PublishFile[];
  /** Used for commit messages and the pull request */
  title: string;
  pullRequestBody: string;
  /**
   * Files uploaded by a previous run that are no longer part of the post,
   * with the git blob sha recorded when they were uploaded. A file is only
   * deleted if the blob currently on the branch still has that sha, i.e. it
   * still holds exactly what the plugin uploaded.
   */
  deleteFiles?: OwnedFile[];
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
  /** Repository paths that were deleted from the branch */
  filesDeleted: string[];
  /**
   * Obsolete files that were NOT deleted because the branch holds different
   * content than the plugin uploaded (e.g. edited by a maintainer).
   */
  deletesSkipped: string[];
  /** Blob sha now on the branch for every file in `files` */
  fileShas: Record<string, string>;
};

/**
 * Where a post gets published. The plugin only ships a GitHub implementation,
 * but the publisher depends on this interface only.
 */
export interface PublishGateway {
  publishPost(input: PublishPostInput): Promise<PublishPostResult>;
}
