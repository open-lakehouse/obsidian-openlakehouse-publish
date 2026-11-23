import type { RequestUrlParam } from "obsidian";
import type { HttpResponse } from "src/gateway";

/**
 * In-memory fake of the parts of the GitHub REST API used by GitHubGateway.
 * It is used as a drop-in replacement for Obsidian's `requestUrl`.
 */

type FakeRepo = {
  owner: string;
  name: string;
  push: boolean;
  defaultBranch?: string;
  fork?: { parent: string };
  /** Branches that have diverged from upstream: merge-upstream returns 409 */
  diverged?: string[];
  /** branch -> commit sha */
  branches: Record<string, string>;
  /** branch -> path -> { sha, content (base64) } */
  files: Record<string, Record<string, { sha: string; content: string }>>;
};

type FakePull = {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  base: string;
  headRepo: string;
  headRef: string;
  maintainer_can_modify?: boolean;
};

export type RecordedRequest = {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
};

type FakeFileMap = Record<string, { sha: string; content: string }>;

type DeleteResponse = {
  status: number;
  message: string;
  mutate?: (files: FakeFileMap, path: string) => void;
};

let shaCounter = 1;
const nextSha = () => (shaCounter++).toString(16).padStart(40, "0");

export class FakeGitHub {
  repos: Record<string, FakeRepo> = {};
  pulls: Record<string, FakePull[]> = {};
  requests: RecordedRequest[] = [];
  login = "octocat";
  token = "TOKEN";
  /** Number of ref lookups a new fork answers with 404 before being ready */
  forkReadyAfter = 0;
  /** One-shot DELETE response used to simulate races in gateway tests. */
  nextDeleteResponse?: DeleteResponse;
  private forkLookups = 0;

  addRepo(fullName: string, opts: Partial<FakeRepo> = {}) {
    const [owner, name] = fullName.split("/");
    const repo: FakeRepo = {
      owner,
      name,
      push: true,
      branches: { main: nextSha() },
      files: { main: {} },
      ...opts,
    };
    this.repos[fullName.toLowerCase()] = repo;
    return repo;
  }

  repo(fullName: string) {
    return this.repos[fullName.toLowerCase()];
  }

  file(fullName: string, branch: string, path: string) {
    return this.repo(fullName)?.files[branch]?.[path];
  }

  fileText(fullName: string, branch: string, path: string) {
    const f = this.file(fullName, branch, path);
    return f && Buffer.from(f.content, "base64").toString("utf-8");
  }

  addPull(target: string, pull: Omit<FakePull, "number">) {
    const list = (this.pulls[target.toLowerCase()] ||= []);
    const pr = { ...pull, number: 100 + list.length };
    list.push(pr);
    return pr;
  }

  requestsMatching(method: string, pathPrefix: string | RegExp) {
    return this.requests.filter(
      (r) =>
        r.method === method &&
        (typeof pathPrefix === "string"
          ? r.path.startsWith(pathPrefix)
          : pathPrefix.test(r.path)),
    );
  }

  private pullJson(target: string, pr: FakePull) {
    return {
      number: pr.number,
      state: pr.state,
      title: pr.title,
      html_url: `https://github.com/${target}/pull/${pr.number}`,
      head: { ref: pr.headRef, repo: { full_name: pr.headRepo } },
      base: { ref: pr.base },
    };
  }

  requestUrl = async (params: RequestUrlParam): Promise<HttpResponse> => {
    const url = new URL(params.url);
    const method = (params.method || "GET").toUpperCase();
    const body = params.body ? JSON.parse(params.body as string) : undefined;
    const headers = (params.headers || {}) as Record<string, string>;
    this.requests.push({
      method,
      url: params.url,
      path: decodeURIComponent(url.pathname + url.search),
      headers,
      body,
    });
    if (params.throw !== false) {
      throw new Error("GitHubGateway must always pass throw: false");
    }
    if (headers.Authorization !== `Bearer ${this.token}`) {
      return this.respond(401, { message: "Bad credentials" });
    }
    return this.route(method, url, body);
  };

  private respond(status: number, json?: unknown): HttpResponse {
    return { status, json: Promise.resolve(json) };
  }

  private route(method: string, url: URL, body: any): HttpResponse {
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/user") {
      return this.respond(200, { login: this.login });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && method === "GET") {
      const repo = this.repo(`${m[1]}/${m[2]}`);
      if (!repo) return this.respond(404, { message: "Not Found" });
      return this.respond(200, {
        full_name: `${repo.owner}/${repo.name}`,
        fork: !!repo.fork,
        parent: repo.fork && { full_name: repo.fork.parent },
        permissions: { push: repo.push },
      });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/forks$/)) && method === "POST") {
      const parent = this.repo(`${m[1]}/${m[2]}`);
      if (!parent) return this.respond(404, { message: "Not Found" });
      const onlyDefault = body?.default_branch_only === true;
      const def = parent.defaultBranch || "main";
      const copyBranches = onlyDefault
        ? { [def]: parent.branches[def] }
        : { ...parent.branches };
      const copyFiles = JSON.parse(
        JSON.stringify(onlyDefault ? { [def]: parent.files[def] } : parent.files),
      );
      const fork = this.addRepo(`${this.login}/${parent.name}`, {
        push: true,
        fork: { parent: `${parent.owner}/${parent.name}` },
        branches: copyBranches,
        files: copyFiles,
      });
      this.forkLookups = 0;
      return this.respond(202, {
        name: fork.name,
        owner: { login: fork.owner },
      });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
      const full = `${m[1]}/${m[2]}`;
      const repo = this.repo(full);
      if (repo?.fork && this.forkLookups++ < this.forkReadyAfter) {
        return this.respond(404, { message: "Not Found" });
      }
      const branch = decodeURIComponent(m[3]);
      const sha = repo?.branches[branch];
      if (!sha) return this.respond(404, { message: "Not Found" });
      return this.respond(200, {
        ref: `refs/heads/${branch}`,
        object: { sha, type: "commit" },
      });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/merge-upstream$/)) && method === "POST") {
      const repo = this.repo(`${m[1]}/${m[2]}`);
      if (!repo?.fork) return this.respond(404, { message: "Not Found" });
      const parent = this.repo(repo.fork.parent);
      const branch = body?.branch;
      if (!repo.branches[branch] || !parent.branches[branch]) {
        return this.respond(422, { message: "Branch not found" });
      }
      if (repo.diverged?.includes(branch)) {
        return this.respond(409, { message: "There are merge conflicts" });
      }
      repo.branches[branch] = parent.branches[branch];
      repo.files[branch] = JSON.parse(JSON.stringify(parent.files[branch] || {}));
      return this.respond(200, { merge_type: "fast-forward", base_branch: `${parent.owner}:${branch}` });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/)) && method === "POST") {
      const repo = this.repo(`${m[1]}/${m[2]}`);
      if (!repo) return this.respond(404, { message: "Not Found" });
      if (!repo.push) return this.respond(403, { message: "Resource not accessible" });
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (repo.branches[branch]) {
        return this.respond(422, { message: "Reference already exists" });
      }
      const source = Object.entries(repo.branches).find(([, sha]) => sha === body.sha);
      if (!source) {
        return this.respond(422, { message: "Object does not exist" });
      }
      repo.branches[branch] = body.sha;
      repo.files[branch] = JSON.parse(JSON.stringify(repo.files[source[0]] || {}));
      return this.respond(201, { ref: body.ref, object: { sha: body.sha } });
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const repo = this.repo(`${m[1]}/${m[2]}`);
      if (!repo) return this.respond(404, { message: "Not Found" });
      const filePath = decodeURIComponent(m[3]);
      if (method === "GET") {
        const branch = url.searchParams.get("ref") || "main";
        const f = repo.files[branch]?.[filePath];
        if (!f) return this.respond(404, { message: "Not Found" });
        // GitHub wraps base64 content at 60 characters
        const wrapped = f.content.replace(/(.{60})/g, "$1\n");
        return this.respond(200, { sha: f.sha, content: wrapped, encoding: "base64" });
      }
      if (method === "PUT") {
        if (!repo.push) return this.respond(403, { message: "Resource not accessible" });
        const branch = body.branch;
        const files = repo.files[branch];
        if (!files) return this.respond(404, { message: "Branch not found" });
        const existing = files[filePath];
        if (existing && body.sha !== existing.sha) {
          return this.respond(409, { message: "sha does not match" });
        }
        if (!existing && body.sha) {
          return this.respond(422, { message: "sha given for new file" });
        }
        const sha = nextSha();
        files[filePath] = { sha, content: body.content };
        repo.branches[branch] = nextSha();
        return this.respond(existing ? 200 : 201, { content: { sha, path: filePath } });
      }
      if (method === "DELETE") {
        if (!repo.push) return this.respond(403, { message: "Resource not accessible" });
        const files = repo.files[body.branch];
        if (this.nextDeleteResponse) {
          const response = this.nextDeleteResponse;
          this.nextDeleteResponse = undefined;
          response.mutate?.(files, filePath);
          return this.respond(response.status, { message: response.message });
        }
        const existing = files?.[filePath];
        if (!existing) return this.respond(404, { message: "Not Found" });
        if (body.sha !== existing.sha) {
          return this.respond(409, { message: "sha does not match" });
        }
        delete files[filePath];
        repo.branches[body.branch] = nextSha();
        return this.respond(200, { content: null });
      }
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
      const target = `${m[1]}/${m[2]}`;
      const list = (this.pulls[target.toLowerCase()] ||= []);
      if (method === "GET") {
        const head = url.searchParams.get("head");
        const state = url.searchParams.get("state") || "open";
        const found = list.filter(
          (p) =>
            p.state === state &&
            (!head || `${p.headRepo.split("/")[0]}:${p.headRef}` === head),
        );
        return this.respond(200, found.map((p) => this.pullJson(target, p)));
      }
      if (method === "POST") {
        const [headOwner, headRef] = String(body.head).includes(":")
          ? String(body.head).split(":")
          : [m[1], body.head];
        const headRepo = Object.values(this.repos).find(
          (r) =>
            r.owner.toLowerCase() === headOwner.toLowerCase() &&
            (r.name === m![2] || r.fork?.parent.toLowerCase() === target.toLowerCase()),
        );
        if (!headRepo || !headRepo.branches[headRef]) {
          return this.respond(422, { message: "Validation Failed: head" });
        }
        const pr = this.addPull(target, {
          state: "open",
          title: body.title,
          body: body.body,
          base: body.base,
          headRepo: `${headRepo.owner}/${headRepo.name}`,
          headRef,
          maintainer_can_modify: body.maintainer_can_modify,
        });
        return this.respond(201, this.pullJson(target, pr));
      }
    }

    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/)) && method === "GET") {
      const target = `${m[1]}/${m[2]}`;
      const pr = (this.pulls[target.toLowerCase()] || []).find(
        (p) => p.number === Number(m![3]),
      );
      if (!pr) return this.respond(404, { message: "Not Found" });
      return this.respond(200, this.pullJson(target, pr));
    }

    return this.respond(404, { message: `Fake: no route for ${method} ${path}` });
  }
}
