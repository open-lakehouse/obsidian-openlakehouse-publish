import { expect } from "chai";
import fetchMock from "fetch-mock";
import GitHubGateway, { GitHubError, parseRepo } from "src/github-gateway";
import { toBase64 } from "src/base64";
import type { PublishPostInput } from "src/gateway";
import { FakeGitHub } from "./fake-github";
import { fetchRequestUrlWrapper } from "./obsidian-wrappers";

const TARGET = "open-lakehouse/openlakehouse-io";
const POST_DIR = "src/content/posts/iceberg/my-post";

const input = (overrides?: Partial<PublishPostInput>): PublishPostInput => ({
  branch: "obsidian/my-post",
  title: "My post",
  pullRequestBody: "Body",
  files: [
    { path: `${POST_DIR}/index.mdx`, content: "---\ntitle: My post\n---\n\nHello\n" },
    { path: `${POST_DIR}/diagram.png`, content: new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]).buffer },
  ],
  ...overrides,
});

describe("parseRepo", () => {
  it("parses owner/name", () => {
    expect(parseRepo(" open-lakehouse/openlakehouse-io ")).to.deep.equal({
      owner: "open-lakehouse",
      repo: "openlakehouse-io",
    });
  });

  it("rejects invalid values", () => {
    expect(parseRepo("")).to.be.undefined;
    expect(parseRepo("no-slash")).to.be.undefined;
    expect(parseRepo("a/b/c")).to.be.undefined;
  });
});

describe("base64", () => {
  it("matches node's encoding for text and binary", () => {
    for (const s of ["", "a", "ab", "abc", "héllo wörld ✓ {x}"]) {
      expect(toBase64(s)).to.equal(Buffer.from(s, "utf-8").toString("base64"));
    }
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(toBase64(bytes.buffer)).to.equal(Buffer.from(bytes).toString("base64"));
  });
});

describe("GitHubGateway", () => {
  let github: FakeGitHub;

  const gateway = (opts: Partial<ConstructorParameters<typeof GitHubGateway>[0]> = {}) =>
    new GitHubGateway(
      {
        token: github.token,
        targetRepo: parseRepo(TARGET)!,
        baseBranch: "main",
        sleep: async () => {},
        ...opts,
      },
      github.requestUrl,
    );

  beforeEach(() => {
    github = new FakeGitHub();
    github.addRepo(TARGET, { push: true });
  });

  it("sends the token as a Bearer token with GitHub API headers", async () => {
    await gateway().publishPost(input());
    expect(github.requests.length).to.be.greaterThan(0);
    for (const r of github.requests) {
      expect(r.headers.Authorization).to.equal("Bearer TOKEN");
      expect(r.headers.Accept).to.equal("application/vnd.github+json");
    }
  });

  it("fails with a helpful error on bad credentials", async () => {
    const error = await gateway({ token: "WRONG" })
      .publishPost(input())
      .catch((e) => e);
    expect(error).to.be.instanceOf(GitHubError);
    expect(error.status).to.equal(401);
    expect(error.message).to.contain("Bad credentials");
  });

  it("refuses to run without a token", async () => {
    await gateway({ token: "" }).publishPost(input()).should.be.rejectedWith(
      "No GitHub token configured",
    );
  });

  describe("Create path (first publish, push access to target)", () => {
    it("creates the branch from the base branch, uploads files, and opens a PR", async () => {
      const baseSha = github.repo(TARGET).branches.main;
      const result = await gateway().publishPost(input());

      const createRef = github.requestsMatching("POST", `/repos/${TARGET}/git/refs`);
      expect(createRef).to.have.length(1);
      expect(createRef[0].body).to.deep.equal({
        ref: "refs/heads/obsidian/my-post",
        sha: baseSha,
      });

      expect(github.fileText(TARGET, "obsidian/my-post", `${POST_DIR}/index.mdx`)).to.equal(
        "---\ntitle: My post\n---\n\nHello\n",
      );
      const png = github.file(TARGET, "obsidian/my-post", `${POST_DIR}/diagram.png`)!;
      expect(Buffer.from(png.content, "base64")).to.deep.equal(
        Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]),
      );

      const puts = github.requestsMatching("PUT", `/repos/${TARGET}/contents/`);
      expect(puts).to.have.length(2);
      for (const put of puts) {
        expect(put.body.branch).to.equal("obsidian/my-post");
        expect(put.body).not.to.have.property("sha");
      }
      expect(github.file(TARGET, "main", `${POST_DIR}/index.mdx`)).to.be.undefined;

      const createPr = github.requestsMatching("POST", `/repos/${TARGET}/pulls`);
      expect(createPr).to.have.length(1);
      expect(createPr[0].body).to.deep.equal({
        title: "My post",
        head: "obsidian/my-post",
        base: "main",
        body: "Body",
      });

      expect(result).to.deep.equal({
        headRepo: TARGET,
        branch: "obsidian/my-post",
        pullRequestNumber: 100,
        pullRequestUrl: `https://github.com/${TARGET}/pull/100`,
        branchCreated: true,
        pullRequestCreated: true,
        filesWritten: [`${POST_DIR}/index.mdx`, `${POST_DIR}/diagram.png`],
      });
    });

    it("URL-encodes path segments but keeps the slashes", async () => {
      await gateway().publishPost(
        input({ files: [{ path: `${POST_DIR}/my image.png`, content: "x" }] }),
      );
      const put = github.requestsMatching("PUT", `/repos/${TARGET}/contents/`)[0];
      expect(put.url).to.contain(`/contents/${POST_DIR}/my%20image.png`);
    });

    it("fails clearly when the base branch does not exist", async () => {
      await gateway({ baseBranch: "nope" })
        .publishPost(input())
        .should.be.rejectedWith("base branch nope not found");
    });
  });

  describe("Update path (re-publish)", () => {
    let first: Awaited<ReturnType<GitHubGateway["publishPost"]>>;

    beforeEach(async () => {
      first = await gateway().publishPost(input());
      github.requests = [];
    });

    it("reuses the branch and the open PR, and passes the existing sha", async () => {
      const oldSha = github.file(TARGET, "obsidian/my-post", `${POST_DIR}/index.mdx`)!.sha;
      const result = await gateway().publishPost(
        input({
          previousPullRequestNumber: first.pullRequestNumber,
          files: [{ path: `${POST_DIR}/index.mdx`, content: "changed\n" }],
        }),
      );
      expect(github.requestsMatching("POST", `/repos/${TARGET}/git/refs`)).to.be.empty;
      expect(github.requestsMatching("POST", `/repos/${TARGET}/pulls`)).to.be.empty;
      const put = github.requestsMatching("PUT", `/repos/${TARGET}/contents/`);
      expect(put).to.have.length(1);
      expect(put[0].body.sha).to.equal(oldSha);
      expect(github.fileText(TARGET, "obsidian/my-post", `${POST_DIR}/index.mdx`)).to.equal("changed\n");
      expect(result).to.include({
        pullRequestNumber: first.pullRequestNumber,
        branchCreated: false,
        pullRequestCreated: false,
      });
    });

    it("skips unchanged files", async () => {
      const result = await gateway().publishPost(input());
      expect(github.requestsMatching("PUT", `/repos/${TARGET}/contents/`)).to.be.empty;
      expect(result.filesWritten).to.be.empty;
    });

    it("finds the open PR by branch when the PR number is unknown", async () => {
      const result = await gateway().publishPost(input());
      expect(result.pullRequestNumber).to.equal(first.pullRequestNumber);
      expect(github.requestsMatching("GET", `/repos/${TARGET}/pulls?`)[0].path).to.contain(
        "head=open-lakehouse:obsidian/my-post",
      );
    });

    it("opens a new PR when the previous one was closed", async () => {
      github.pulls[TARGET][0].state = "closed";
      const result = await gateway().publishPost(
        input({ previousPullRequestNumber: first.pullRequestNumber }),
      );
      expect(result.pullRequestCreated).to.be.true;
      expect(result.pullRequestNumber).to.not.equal(first.pullRequestNumber);
    });
  });

  describe("Head repository", () => {
    it("uses a configured head repo (fork) and opens a cross-repo PR", async () => {
      github.repo(TARGET).push = false;
      const fork = github.addRepo("me/openlakehouse-io", {
        fork: { parent: TARGET },
        branches: { ...github.repo(TARGET).branches },
      });
      const result = await gateway({ headRepo: parseRepo("me/openlakehouse-io") }).publishPost(input());
      expect(fork.files["obsidian/my-post"][`${POST_DIR}/index.mdx`]).to.exist;
      expect(github.repo(TARGET).branches["obsidian/my-post"]).to.be.undefined;
      const createPr = github.requestsMatching("POST", `/repos/${TARGET}/pulls`)[0];
      expect(createPr.body).to.include({
        head: "me:obsidian/my-post",
        base: "main",
        maintainer_can_modify: true,
      });
      expect(result.headRepo).to.equal("me/openlakehouse-io");
      // No permission probing when the head repo is configured
      expect(github.requestsMatching("GET", /^\/repos\/[^/]+\/[^/]+$/)).to.be.empty;
    });

    it("syncs a stale fork (merge-upstream) and branches from the exact upstream base commit", async () => {
      const fork = github.addRepo("me/openlakehouse-io", { fork: { parent: TARGET } });
      const staleSha = fork.branches.main;
      const upstreamSha = github.repo(TARGET).branches.main;
      expect(staleSha).to.not.equal(upstreamSha);
      await gateway({ headRepo: parseRepo("me/openlakehouse-io") }).publishPost(input());

      const sync = github.requestsMatching("POST", "/repos/me/openlakehouse-io/merge-upstream");
      expect(sync).to.have.length(1);
      expect(sync[0].body).to.deep.equal({ branch: "main" });
      const refs = github.requestsMatching("POST", "/repos/me/openlakehouse-io/git/refs");
      // Both attempts use the upstream sha; the fork's stale sha is never used
      expect(refs.map((r) => r.body.sha)).to.deep.equal([upstreamSha, upstreamSha]);
      expect(fork.files["obsidian/my-post"][`${POST_DIR}/index.mdx`]).to.exist;
    });

    it("fails clearly, without creating a branch, when the fork can't be synced", async () => {
      const fork = github.addRepo("me/openlakehouse-io", {
        fork: { parent: TARGET },
        diverged: ["main"],
      });
      const error = await gateway({ headRepo: parseRepo("me/openlakehouse-io") })
        .publishPost(input())
        .catch((e) => e);
      expect(error).to.be.instanceOf(GitHubError);
      expect(error.message).to.contain("could not sync main of fork me/openlakehouse-io");
      expect(error.message).to.contain("There are merge conflicts");
      expect(fork.branches["obsidian/my-post"]).to.be.undefined;
      expect(github.requestsMatching("PUT", "/repos/me/openlakehouse-io/contents/")).to.be.empty;
      expect(github.requestsMatching("POST", `/repos/${TARGET}/pulls`)).to.be.empty;
    });

    it("fails if the fork still lacks the upstream commit after syncing", async () => {
      github.addRepo("me/openlakehouse-io", { fork: { parent: TARGET } });
      // Upstream moves on between the sync and the retry
      const realRequest = github.requestUrl;
      const gw = new GitHubGateway(
        { token: github.token, targetRepo: parseRepo(TARGET)!, headRepo: parseRepo("me/openlakehouse-io"), baseBranch: "main" },
        async (params) => {
          const response = await realRequest(params);
          if (params.url.endsWith("/merge-upstream")) {
            github.repo("me/openlakehouse-io").branches.main = "f".repeat(40);
          }
          return response;
        },
      );
      await gw.publishPost(input()).should.be.rejectedWith("not creating obsidian/my-post from stale history");
    });

    it("forks the target when no head repo is configured and the token can't push", async () => {
      github.repo(TARGET).push = false;
      github.forkReadyAfter = 2;
      const result = await gateway().publishPost(input());
      const forkRequests = github.requestsMatching("POST", `/repos/${TARGET}/forks`);
      expect(forkRequests).to.have.length(1);
      expect(forkRequests[0].body).not.to.have.property("default_branch_only");
      expect(result.headRepo).to.equal("octocat/openlakehouse-io");
      expect(github.file("octocat/openlakehouse-io", "obsidian/my-post", `${POST_DIR}/index.mdx`)).to.exist;
    });

    it("forks all branches, so a non-default base branch works", async () => {
      const target = github.repo(TARGET);
      target.push = false;
      target.branches.release = "a".repeat(40);
      target.files.release = {};
      github.forkReadyAfter = 1;
      const result = await gateway({ baseBranch: "release" }).publishPost(input());
      expect(result.headRepo).to.equal("octocat/openlakehouse-io");
      const refs = github.requestsMatching("POST", "/repos/octocat/openlakehouse-io/git/refs");
      expect(refs.map((r) => r.body.sha)).to.deep.equal(["a".repeat(40)]);
      expect(github.requestsMatching("POST", `/repos/${TARGET}/pulls`)[0].body.base).to.equal("release");
    });

    it("reuses an existing fork", async () => {
      github.repo(TARGET).push = false;
      github.addRepo("octocat/openlakehouse-io", {
        fork: { parent: TARGET },
        branches: { ...github.repo(TARGET).branches },
      });
      const result = await gateway().publishPost(input());
      expect(github.requestsMatching("POST", `/repos/${TARGET}/forks`)).to.be.empty;
      expect(result.headRepo).to.equal("octocat/openlakehouse-io");
    });

    it("gives up if the fork never becomes ready", async () => {
      github.repo(TARGET).push = false;
      github.forkReadyAfter = 100;
      await gateway({ forkPollAttempts: 3 })
        .publishPost(input())
        .should.be.rejectedWith("was not ready in time");
    });
  });

  describe("via fetch (fetch-mock)", () => {
    afterEach(() => {
      fetchMock.restore();
    });

    it("surfaces GitHub's error message", async () => {
      fetchMock.get(`https://api.github.com/repos/me/fork/git/ref/heads/obsidian/my-post`, {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      });
      const gw = new GitHubGateway(
        {
          token: "T",
          targetRepo: parseRepo(TARGET)!,
          headRepo: parseRepo("me/fork"),
          baseBranch: "main",
        },
        fetchRequestUrlWrapper,
      );
      await gw
        .publishPost(input())
        .should.be.rejectedWith(/403.*Resource not accessible by personal access token/);
      const [, options] = fetchMock.lastCall()!;
      expect((options!.headers as Record<string, string>).Authorization).to.equal("Bearer T");
    });
  });
});
