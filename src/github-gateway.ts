import { toBase64 } from "./base64";
import type {
  HttpResponse,
  MakeHttpRequest,
  PublishFile,
  PublishGateway,
  PublishPostInput,
  PublishPostResult,
} from "./gateway";

export type RepoRef = { owner: string; repo: string };

export const parseRepo = (input: string): RepoRef | undefined => {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(input || "");
  return match ? { owner: match[1], repo: match[2] } : undefined;
};

export const repoName = (r: RepoRef) => `${r.owner}/${r.repo}`;

const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase();

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export type GitHubGatewayOptions = {
  token: string;
  /** Repository receiving the pull request */
  targetRepo: RepoRef;
  baseBranch: string;
  /**
   * Repository holding the branch. When omitted, the target repository is used
   * if the token can push to it, otherwise the authenticated user's fork is
   * used (and created if it doesn't exist).
   */
  headRepo?: RepoRef;
  apiBaseUrl?: string;
  /** Injected for tests; used while waiting for a new fork to become ready */
  sleep?: (ms: number) => Promise<void>;
  forkPollAttempts?: number;
};

type ApiResult = { status: number; json: any };
type RemoteClassification = "missing" | "changed" | "same";

const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

const readJson = async (response: HttpResponse): Promise<any> => {
  try {
    // Obsidian's `json` is a getter that throws on non-JSON bodies
    return await response.json;
  } catch {
    return undefined;
  }
};

/**
 * Publishes files to GitHub by committing them to a branch with the Contents
 * API and opening (or reusing) a pull request against the target repository.
 */
export default class GitHubGateway implements PublishGateway {
  private options: GitHubGatewayOptions;
  private requestUrl: MakeHttpRequest;
  private resolvedHeadRepo?: RepoRef;

  constructor(options: GitHubGatewayOptions, requestUrl: MakeHttpRequest) {
    this.options = options;
    this.requestUrl = requestUrl;
  }

  private get apiBase() {
    return (this.options.apiBaseUrl || "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult> {
    if (!this.options.token) {
      throw new GitHubError("No GitHub token configured", 401);
    }
    const response = await this.requestUrl({
      url: `${this.apiBase}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body !== undefined && {
        body: JSON.stringify(body),
        contentType: "application/json",
      }),
      throw: false,
    });
    return { status: response.status, json: await readJson(response) };
  }

  private async expect(
    result: Promise<ApiResult>,
    what: string,
    ok: number[] = [200, 201],
  ) {
    const r = await result;
    if (!ok.includes(r.status)) {
      const message =
        (r.json && typeof r.json.message === "string" && r.json.message) ||
        "unexpected response";
      throw new GitHubError(
        `GitHub: ${what} failed (${r.status}): ${message}`,
        r.status,
      );
    }
    return r.json;
  }

  private async classifyRemote(
    remote: ApiResult,
    path: string,
    sha: string,
  ): Promise<RemoteClassification> {
    if (remote.status === 404) {
      return "missing";
    }
    const json = await this.expect(Promise.resolve(remote), `reading ${path}`, [200]);
    return !json || Array.isArray(json) || json.sha !== sha ? "changed" : "same";
  }

  async resolveHeadRepo(): Promise<RepoRef> {
    if (this.resolvedHeadRepo) {
      return this.resolvedHeadRepo;
    }
    const { targetRepo, headRepo } = this.options;
    if (headRepo) {
      this.resolvedHeadRepo = headRepo;
      return headRepo;
    }
    const target = await this.expect(
      this.api("GET", `/repos/${repoName(targetRepo)}`),
      `reading ${repoName(targetRepo)}`,
      [200],
    );
    if (target?.permissions?.push) {
      this.resolvedHeadRepo = targetRepo;
    } else {
      this.resolvedHeadRepo = await this.ensureFork();
    }
    return this.resolvedHeadRepo;
  }

  private async ensureFork(): Promise<RepoRef> {
    const { targetRepo, baseBranch } = this.options;
    const user = await this.expect(
      this.api("GET", "/user"),
      "reading the authenticated user",
      [200],
    );
    const login: string = user.login;
    const existing = await this.api(
      "GET",
      `/repos/${login}/${targetRepo.repo}`,
    );
    if (
      existing.status === 200 &&
      existing.json?.fork &&
      existing.json?.parent?.full_name?.toLowerCase() ===
        repoName(targetRepo).toLowerCase()
    ) {
      return { owner: login, repo: targetRepo.repo };
    }
    const created = await this.expect(
      // All branches: the configured base branch need not be the default one
      this.api("POST", `/repos/${repoName(targetRepo)}/forks`, {}),
      `forking ${repoName(targetRepo)}`,
      [200, 201, 202],
    );
    const fork: RepoRef = {
      owner: created?.owner?.login || login,
      repo: created?.name || targetRepo.repo,
    };
    // Forking is asynchronous - wait until the base branch exists in the fork
    const attempts = this.options.forkPollAttempts ?? 10;
    const sleep =
      this.options.sleep ||
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
      const ref = await this.api(
        "GET",
        `/repos/${repoName(fork)}/git/ref/heads/${encodePath(baseBranch)}`,
      );
      if (ref.status === 200) {
        return fork;
      }
      await sleep(2000);
    }
    throw new GitHubError(
      `GitHub: fork ${repoName(fork)} was not ready in time, please try again`,
      504,
    );
  }

  private async getBranchSha(repo: RepoRef, branch: string) {
    const r = await this.api(
      "GET",
      `/repos/${repoName(repo)}/git/ref/heads/${encodePath(branch)}`,
    );
    if (r.status === 404) {
      return undefined;
    }
    const json = await this.expect(
      Promise.resolve(r),
      `reading branch ${branch} in ${repoName(repo)}`,
      [200],
    );
    return json?.object?.sha as string;
  }

  /** @returns true if the branch was created */
  async ensureBranch(head: RepoRef, branch: string): Promise<boolean> {
    const { targetRepo, baseBranch } = this.options;
    if (await this.getBranchSha(head, branch)) {
      return false;
    }
    const baseSha = await this.getBranchSha(targetRepo, baseBranch);
    if (!baseSha) {
      throw new GitHubError(
        `GitHub: base branch ${baseBranch} not found in ${repoName(targetRepo)}`,
        404,
      );
    }
    const create = (sha: string) =>
      this.api("POST", `/repos/${repoName(head)}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    let result = await create(baseSha);
    if (result.status === 422 && !sameRepo(head, targetRepo)) {
      // The fork doesn't have the upstream commit yet. Sync the fork's base
      // branch with upstream and retry at exactly the same commit - never
      // start a pull request from the fork's (possibly stale) history.
      const sync = await this.api(
        "POST",
        `/repos/${repoName(head)}/merge-upstream`,
        { branch: baseBranch },
      );
      if (sync.status !== 200) {
        const reason = (sync.json && sync.json.message) || "unexpected response";
        throw new GitHubError(
          `GitHub: could not sync ${baseBranch} of fork ${repoName(head)} with ${repoName(targetRepo)} (${sync.status}): ${reason}. ` +
            `Sync the fork on GitHub (its ${baseBranch} branch must not have diverged), then try again.`,
          sync.status,
        );
      }
      result = await create(baseSha);
      if (result.status === 422) {
        throw new GitHubError(
          `GitHub: fork ${repoName(head)} still doesn't contain ${repoName(targetRepo)}@${baseBranch} (${baseSha.substring(0, 7)}) after syncing; not creating ${branch} from stale history. Please try again shortly.`,
          422,
        );
      }
    }
    await this.expect(
      Promise.resolve(result),
      `creating branch ${branch} in ${repoName(head)}`,
      [201],
    );
    return true;
  }

  /** @returns the blob sha now on the branch, and whether the file was written */
  async upsertFile(
    head: RepoRef,
    branch: string,
    file: PublishFile,
    postTitle: string,
  ): Promise<{ written: boolean; sha: string }> {
    const contentsPath = `/repos/${repoName(head)}/contents/${encodePath(file.path)}`;
    const existing = await this.api(
      "GET",
      `${contentsPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (existing.status !== 200 && existing.status !== 404) {
      await this.expect(Promise.resolve(existing), `reading ${file.path}`, [
        200,
      ]);
    }
    const content = toBase64(file.content);
    const sha: string | undefined =
      existing.status === 200 ? existing.json?.sha : undefined;
    if (
      existing.status === 200 &&
      typeof existing.json?.content === "string" &&
      existing.json.content.replace(/\s/g, "") === content
    ) {
      return { written: false, sha: sha as string };
    }
    const put = await this.expect(
      this.api("PUT", contentsPath, {
        message: `${sha ? "Update" : "Add"} ${file.path.split("/").pop()} for "${postTitle}"`,
        content,
        branch,
        ...(sha && { sha }),
      }),
      `writing ${file.path}`,
      [200, 201],
    );
    const newSha = put?.content?.sha;
    if (typeof newSha !== "string") {
      throw new GitHubError(`GitHub: writing ${file.path} returned no blob sha`, 502);
    }
    return { written: true, sha: newSha };
  }

  /**
   * Deletes `file.path` from the branch, but only if the blob on the branch
   * still has the sha the plugin recorded when uploading it.
   * @returns "deleted", "missing" (not on the branch) or "changed" (content
   * differs from what the plugin uploaded - left alone)
   */
  async deleteOwnedFile(
    head: RepoRef,
    branch: string,
    file: { path: string; sha: string },
    postTitle: string,
  ): Promise<"deleted" | "missing" | "changed"> {
    const contentsPath = `/repos/${repoName(head)}/contents/${encodePath(file.path)}`;
    const existing = await this.api(
      "GET",
      `${contentsPath}?ref=${encodeURIComponent(branch)}`,
    );
    const existingState = await this.classifyRemote(existing, file.path, file.sha);
    if (existingState !== "same") {
      return existingState;
    }
    const result = await this.api("DELETE", contentsPath, {
      message: `Remove ${file.path.split("/").pop()} for "${postTitle}"`,
      // GitHub rejects the delete if the file changed since we looked
      sha: file.sha,
      branch,
    });
    if ([404, 409, 422].includes(result.status)) {
      const current = await this.api(
        "GET",
        `${contentsPath}?ref=${encodeURIComponent(branch)}`,
      );
      let currentState: RemoteClassification;
      try {
        currentState = await this.classifyRemote(current, file.path, file.sha);
      } catch {
        await this.expect(Promise.resolve(result), `deleting ${file.path}`, [200]);
        throw new Error("unreachable");
      }
      if (currentState !== "same") {
        return currentState;
      }
    }
    await this.expect(Promise.resolve(result), `deleting ${file.path}`, [200]);
    return "deleted";
  }

  async ensurePullRequest(
    head: RepoRef,
    input: PublishPostInput,
  ): Promise<{ number: number; url: string; created: boolean }> {
    const { targetRepo, baseBranch } = this.options;
    const target = repoName(targetRepo);
    const isOpenForBranch = (pr: any) =>
      pr &&
      pr.state === "open" &&
      pr.head?.ref === input.branch &&
      (!pr.head?.repo?.full_name ||
        pr.head.repo.full_name.toLowerCase() === repoName(head).toLowerCase());

    if (input.previousPullRequestNumber) {
      const r = await this.api(
        "GET",
        `/repos/${target}/pulls/${input.previousPullRequestNumber}`,
      );
      if (r.status === 200 && isOpenForBranch(r.json)) {
        return { number: r.json.number, url: r.json.html_url, created: false };
      }
    }
    const list = await this.expect(
      this.api(
        "GET",
        `/repos/${target}/pulls?state=open&head=${encodeURIComponent(
          `${head.owner}:${input.branch}`,
        )}`,
      ),
      "listing pull requests",
      [200],
    );
    const found = Array.isArray(list) ? list.find(isOpenForBranch) : undefined;
    if (found) {
      return { number: found.number, url: found.html_url, created: false };
    }
    const isFork = !sameRepo(head, targetRepo);
    const pr = await this.expect(
      this.api("POST", `/repos/${target}/pulls`, {
        title: input.title,
        head: isFork ? `${head.owner}:${input.branch}` : input.branch,
        base: baseBranch,
        body: input.pullRequestBody,
        ...(isFork && { maintainer_can_modify: true }),
      }),
      "opening pull request",
      [201],
    );
    return { number: pr.number, url: pr.html_url, created: true };
  }

  async publishPost(input: PublishPostInput): Promise<PublishPostResult> {
    const head = await this.resolveHeadRepo();
    const branchCreated = await this.ensureBranch(head, input.branch);
    const filesWritten: string[] = [];
    const fileShas: Record<string, string> = {};
    for (const file of input.files) {
      const { written, sha } = await this.upsertFile(
        head,
        input.branch,
        file,
        input.title,
      );
      fileShas[file.path] = sha;
      if (written) {
        filesWritten.push(file.path);
      }
    }
    const filesDeleted: string[] = [];
    const deletesSkipped: string[] = [];
    const seen = new Set(input.files.map((f) => f.path));
    for (const file of input.deleteFiles || []) {
      if (seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      const outcome = await this.deleteOwnedFile(head, input.branch, file, input.title);
      if (outcome === "deleted") {
        filesDeleted.push(file.path);
      } else if (outcome === "changed") {
        deletesSkipped.push(file.path);
      }
    }
    const pr = await this.ensurePullRequest(head, input);
    return {
      headRepo: repoName(head),
      branch: input.branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.url,
      branchCreated,
      pullRequestCreated: pr.created,
      filesWritten,
      filesDeleted,
      deletesSkipped,
      fileShas,
    };
  }
}
