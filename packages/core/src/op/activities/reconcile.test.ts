import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reconcilePr,
  reconcileSummary,
  reconcileBranchName,
  entriesFromPlan,
  commentMarker,
  issueMarker,
  pullRequestContextFrom,
  mergeRequestContextFrom,
  gitlabNoteTokenFrom,
  gitlabProjectContextFrom,
  githubApiBaseFrom,
  commentTokenFrom,
  noCommentTokenMessage,
  noIssueIdentityMessage,
  unsafeMarkerMessage,
  suppliedMarker,
  noIssueTokenMessage,
  postOrUpdateGithubIssue,
  ghCredentialEnv,
  githubShapedForgeFrom,
} from "./reconcile";

// ── The `gh` stub (chant #2291) ──────────────────────────────────────────────
//
// Same recipe as `lexicons/terraform/src/op/activities/terraform.test.ts` and
// `lexicons/k3s/src/op/activities/k3s.test.ts`: `node:child_process`'s `exec`
// carries a `nodejs.util.promisify.custom` implementation, which is what
// `promisify(exec)` picks up at module load, so every `gh` invocation
// `postOrUpdateComment` makes lands in `ghCalls` with its exact command
// string and options — including the `env` it was given, so a test can prove
// which token actually reached `gh`.

interface GhCall {
  cmd: string;
  opts: { signal?: AbortSignal; env?: Record<string, string | undefined> };
}

const ghCalls: GhCall[] = [];
/** cmd substring -> stdout to answer with. First match wins. */
let ghReplies: Array<{ match: string; stdout: string }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string, opts?: GhCall["opts"]) => {
    ghCalls.push({ cmd, opts: opts ?? {} });
    const hit = ghReplies.find(({ match }) => cmd.includes(match));
    return { stdout: hit?.stdout ?? "", stderr: "" };
  };
  return { ...(await importOriginal<typeof import("node:child_process")>()), exec };
});

// ── The fake GitHub-shaped forge (chant #3757) ───────────────────────────────
//
// `comment` and `issue` mode reach GitHub and Forgejo through the forge client
// in `pr-forge.ts`, over the global `fetch`. This stands in for one repository
// on either forge: it holds the pull request's comments and the repository's
// issues, pages them the way each forge pages (`per_page` on GitHub, `limit`
// on Forgejo), and applies each POST and PATCH, so a second run reads what the
// first one wrote rather than a canned reply.

interface ForgeCall {
  method: string;
  url: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

interface FakeComment {
  id: number;
  pr: number;
  body: string;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** Set on a pull request, which the issues list returns too. */
  pull_request?: Record<string, unknown> | null;
}

const forgeCalls: ForgeCall[] = [];
let forgeState: { comments: FakeComment[]; issues: FakeIssue[]; failWith?: number };

function forgeJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function fakeForgeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  forgeCalls.push({ method, url, authorization: headers.Authorization, ...(body ? { body } : {}) });
  if (forgeState.failWith) return forgeJson({ message: "token is required" }, forgeState.failWith);

  const u = new URL(url);
  const web = u.origin === "https://api.github.com" ? "https://github.com" : u.origin;
  const m = /\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(u.pathname);
  if (!m) return forgeJson({ message: "Not Found" }, 404);
  const [, repo, rest] = m;
  const size = Number(u.searchParams.get("per_page") ?? u.searchParams.get("limit") ?? "30");
  const page = Number(u.searchParams.get("page") ?? "1");
  const paged = <T>(items: T[]) => items.slice((page - 1) * size, page * size);
  const commentJson = (c: FakeComment) => ({ ...c, html_url: `${web}/${repo}/issues/${c.pr}#issuecomment-${c.id}` });
  const issueJson = (i: FakeIssue) => ({ ...i, html_url: `${web}/${repo}/issues/${i.number}` });

  let hit: RegExpExecArray | null;
  if ((hit = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
    const pr = Number(hit[1]);
    if (method === "GET") return forgeJson(paged(forgeState.comments.filter((c) => c.pr === pr)).map(commentJson));
    const c = { id: 1000 + forgeState.comments.length, pr, body: String(body?.body) };
    forgeState.comments.push(c);
    return forgeJson(commentJson(c), 201);
  }
  if ((hit = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === "PATCH") {
    const c = forgeState.comments.find((x) => x.id === Number(hit![1]));
    if (!c) return forgeJson({ message: "Not Found" }, 404);
    c.body = String(body?.body);
    return forgeJson(commentJson(c));
  }
  if (rest === "/issues" && method === "GET") {
    const state = u.searchParams.get("state") ?? "open";
    return forgeJson(paged(forgeState.issues.filter((i) => state === "all" || i.state === state)).map(issueJson));
  }
  if (rest === "/issues" && method === "POST") {
    const i: FakeIssue = {
      number: forgeState.issues.length + 1,
      title: String(body?.title),
      body: String(body?.body),
      state: "open",
      pull_request: null,
    };
    forgeState.issues.push(i);
    return forgeJson(issueJson(i), 201);
  }
  if ((hit = /^\/issues\/(\d+)$/.exec(rest)) && method === "PATCH") {
    const i = forgeState.issues.find((x) => x.number === Number(hit![1]));
    if (!i) return forgeJson({ message: "Not Found" }, 404);
    Object.assign(i, { title: String(body?.title), body: String(body?.body) });
    return forgeJson(issueJson(i));
  }
  return forgeJson({ message: "Not Found" }, 404);
}

beforeEach(() => {
  ghCalls.length = 0;
  ghReplies = [];
  forgeCalls.length = 0;
  forgeState = { comments: [], issues: [] };
  vi.stubGlobal("fetch", fakeForgeFetch);
});

const entries = [
  { name: "bucket", action: "adopt", type: "AWS::S3::Bucket" },
  { name: "queue", action: "update", type: "AWS::SQS::Queue" },
];

describe("reconcileBranchName (#122)", () => {
  test("deterministic, slugified per env", () => {
    expect(reconcileBranchName("prod")).toBe("chant/reconcile-prod");
    expect(reconcileBranchName("us-east/1")).toBe("chant/reconcile-us-east-1");
  });
});

describe("reconcileSummary (#122)", () => {
  test("summarizes which entries triggered the reconcile", () => {
    const body = reconcileSummary("prod", entries);
    expect(body).toContain("live environment `prod`");
    expect(body).toContain("| bucket | adopt | AWS::S3::Bucket |");
    expect(body).toContain("| queue | update | AWS::SQS::Queue |");
  });

  test("handles an empty entry set", () => {
    expect(reconcileSummary("prod", [])).toContain("_(none)_");
  });
});

describe("entriesFromPlan (#123)", () => {
  test("maps a ChangeSet, dropping noop entries", () => {
    const plan = JSON.stringify({
      env: "prod",
      entries: [
        { name: "a", action: "create", type: "T1", evidence: {}, ownership: "unknown" },
        { name: "b", action: "noop", type: "T2", evidence: {}, ownership: "unknown" },
        { name: "c", action: "delete", type: "T3", evidence: {}, ownership: "owned" },
      ],
    });
    expect(entriesFromPlan(plan)).toEqual([
      { name: "a", action: "create", type: "T1" },
      { name: "c", action: "delete", type: "T3" },
    ]);
  });

  test("tolerates an empty / entry-less plan", () => {
    expect(entriesFromPlan(JSON.stringify({ env: "prod" }))).toEqual([]);
  });
});

describe("reconcilePr report mode (#122)", () => {
  test("returns the summary without any git/network IO", async () => {
    const result = await reconcilePr({ env: "prod", entries, mode: "report" });
    expect(result.mode).toBe("report");
    expect(result.prUrl).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(result.summary).toContain("| bucket | adopt | AWS::S3::Bucket |");
    expect(result.entries).toEqual(entries);
  });
});

describe("reconcilePr pre-built body (#2087)", () => {
  test("a caller-supplied body is used verbatim, in place of the change-set table", async () => {
    const plan = "Terraform will perform the following actions:\n\n  # null_resource.first will be created";
    const result = await reconcilePr({ env: "app", mode: "report", body: plan });
    expect(result.summary).toBe(plan);
    expect(result.summary).not.toContain("| Entry | Action | Type |");
  });

  test("supplying a body derives no plan, so nothing shells to `chant lifecycle plan`", async () => {
    // No `entries`, no mock, no network: if the derivation still ran this
    // would spawn `chant lifecycle plan --json` and reject.
    const result = await reconcilePr({ env: "app", mode: "report", body: "drift" });
    expect(result.entries).toEqual([]);
  });

  test("explicit entries still ride alongside a supplied body", async () => {
    const result = await reconcilePr({ env: "prod", mode: "report", entries, body: "drift" });
    expect(result.summary).toBe("drift");
    expect(result.entries).toEqual(entries);
  });
});

describe("reconcilePr comment mode: the marker (#2231)", () => {
  test("the marker is deterministic per env, so a re-run finds its own comment", () => {
    expect(commentMarker("app")).toBe("<!-- chant-reconcile:app -->");
    expect(commentMarker("app")).toBe(commentMarker("app"));
    expect(commentMarker("app")).not.toBe(commentMarker("db"));
  });

  test("the marker slugifies the env, so nothing it is interpolated next to can be escaped out of", () => {
    // The marker is interpolated into a jq `startswith("…")` string and into a
    // shell word. A quote or a backslash surviving into it would break both.
    const marker = commentMarker('us-east/1" or true; #');
    expect(marker).toBe("<!-- chant-reconcile:us-east-1-or-true- -->");
    expect(marker).not.toMatch(/["'\\]/);
  });
});

describe("pullRequestContextFrom (#2231)", () => {
  const repo = "INTENTIUS/chant";

  test("reads the number off a pull_request event payload", () => {
    expect(pullRequestContextFrom({ GITHUB_REPOSITORY: repo }, { number: 2231 })).toEqual({
      repo,
      number: 2231,
    });
  });

  test("accepts the nested pull_request.number the same payload also carries", () => {
    expect(
      pullRequestContextFrom({ GITHUB_REPOSITORY: repo }, { pull_request: { number: 7 } }),
    ).toEqual({ repo, number: 7 });
  });

  test("falls back to GITHUB_REF when the payload is unreadable", () => {
    expect(
      pullRequestContextFrom({ GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/pull/42/merge" }),
    ).toEqual({ repo, number: 42 });
  });

  test("a push run has no pull request", () => {
    expect(
      pullRequestContextFrom(
        { GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main" },
        { ref: "refs/heads/main", after: "abc" },
      ),
    ).toBeUndefined();
  });

  test("a cron run off any forge has neither variable", () => {
    expect(pullRequestContextFrom({})).toBeUndefined();
    expect(pullRequestContextFrom({ GITHUB_REF: "refs/pull/1/merge" })).toBeUndefined();
  });
});

describe("reconcilePr comment mode refuses a run with no pull request (#2231)", () => {
  test("the message names the mode and every variable it looked for", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    try {
      // No `gh` is ever reached: the context check runs first, so a failure
      // here is the refusal rather than a missing binary.
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /mode "comment".*GITHUB_REPOSITORY.*GITHUB_EVENT_PATH.*GITHUB_REF/s,
      );
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /findingMode "issue" or "report"/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── The GitHub/Forgejo comment, via `gh` at a full URL (#2291) ──────────────

describe("githubApiBaseFrom (#2291)", () => {
  test("defaults to github.com's own API host when GITHUB_API_URL is unset", () => {
    expect(githubApiBaseFrom({})).toBe("https://api.github.com");
    expect(githubApiBaseFrom({ GITHUB_API_URL: "" })).toBe("https://api.github.com");
  });

  test("reads a Forgejo instance's own /api/v1 base, trailing slash stripped", () => {
    expect(githubApiBaseFrom({ GITHUB_API_URL: "http://forgejo:3000/api/v1/" })).toBe(
      "http://forgejo:3000/api/v1",
    );
  });

  test("reads a GitHub Enterprise Server base unchanged", () => {
    expect(githubApiBaseFrom({ GITHUB_API_URL: "https://ghe.example.com/api/v3" })).toBe(
      "https://ghe.example.com/api/v3",
    );
  });
});

describe("commentTokenFrom (#2291)", () => {
  test("GH_TOKEN — what the generated workflow sets from github.token — resolves out of the box", () => {
    expect(commentTokenFrom({ GH_TOKEN: "ghs_x" })).toEqual({ value: "ghs_x", source: "GH_TOKEN" });
  });

  test("falls back to GITHUB_TOKEN when GH_TOKEN is unset", () => {
    expect(commentTokenFrom({ GITHUB_TOKEN: "ghs_y" })).toEqual({ value: "ghs_y", source: "GITHUB_TOKEN" });
  });

  test("CHANT_FORGEJO_TOKEN wins over both, for the cross-instance case", () => {
    expect(
      commentTokenFrom({ CHANT_FORGEJO_TOKEN: "a", GH_TOKEN: "b", GITHUB_TOKEN: "c" })?.source,
    ).toBe("CHANT_FORGEJO_TOKEN");
  });

  test("no token at all is undefined rather than an empty value", () => {
    expect(commentTokenFrom({})).toBeUndefined();
    expect(commentTokenFrom({ GH_TOKEN: "", GITHUB_TOKEN: "" })).toBeUndefined();
  });
});

describe("ghCredentialEnv (#2333)", () => {
  const token = { value: "resolved-token", source: "CHANT_FORGEJO_TOKEN" };

  test("carries the resolved value under GH_ENTERPRISE_TOKEN, the variable a non-github.com host reads", () => {
    expect(ghCredentialEnv({}, token).GH_ENTERPRISE_TOKEN).toBe("resolved-token");
  });

  test("carries it under GH_TOKEN too, so github.com reads the same value it always did", () => {
    expect(ghCredentialEnv({}, token).GH_TOKEN).toBe("resolved-token");
  });

  test("the two never disagree — one resolution, whichever class gh puts the host in", () => {
    const env = ghCredentialEnv({ GH_TOKEN: "stale-ambient" }, token);
    expect(env.GH_TOKEN).toBe(env.GH_ENTERPRISE_TOKEN);
  });

  test("sets no GH_HOST: the full URL already names the host, and GH_HOST is the default for calls that do not", () => {
    expect(ghCredentialEnv({}, token)).not.toHaveProperty("GH_HOST");
  });

  test("passes the rest of the base environment through untouched", () => {
    expect(ghCredentialEnv({ PATH: "/usr/bin", GITHUB_API_URL: "http://forgejo.example/api/v1" }, token))
      .toMatchObject({ PATH: "/usr/bin", GITHUB_API_URL: "http://forgejo.example/api/v1" });
  });
});

describe("reconcilePr comment mode posts through the forge client (#2291, #3757)", () => {
  const repo = "acme/infra";
  const marker = "<!-- chant-reconcile:app -->";

  function stubPrEnv(apiUrl: string): void {
    vi.stubEnv("GITHUB_REPOSITORY", repo);
    vi.stubEnv("GITHUB_REF", "refs/pull/5/merge");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    vi.stubEnv("GITHUB_API_URL", apiUrl);
    vi.stubEnv("GH_TOKEN", "forgejo-actions-token");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("FORGEJO_ACTIONS", "");
    vi.stubEnv("GITEA_ACTIONS", "");
    // Never the GitLab path: a GitHub/Forgejo run carries no merge request.
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
  }

  test("POSTs a new comment at the Forgejo instance's own /api/v1 base", async () => {
    stubPrEnv("http://forgejo.example/api/v1");
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "the plan" });
      expect(result.commentUrl).toBe("http://forgejo.example/acme/infra/issues/5#issuecomment-1000");
      expect(result.pullRequest).toBe("acme/infra#5");
      expect(forgeCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "GET http://forgejo.example/api/v1/repos/acme/infra/issues/5/comments?limit=50&page=1",
        "POST http://forgejo.example/api/v1/repos/acme/infra/issues/5/comments",
      ]);
      expect(forgeCalls[1].body).toEqual({ body: `${marker}\n\nthe plan` });
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a re-run PATCHes the comment it already owns instead of posting a second", async () => {
    stubPrEnv("http://forgejo.example/api/v1");
    forgeState.comments.push({ id: 7, pr: 5, body: "lgtm" }, { id: 42, pr: 5, body: `${marker}\n\nold plan` });
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "a newer plan" });
      expect(result.commentUrl).toBe("http://forgejo.example/acme/infra/issues/5#issuecomment-42");
      expect(forgeCalls.at(-1)).toMatchObject({
        method: "PATCH",
        url: "http://forgejo.example/api/v1/repos/acme/infra/issues/comments/42",
      });
      expect(forgeCalls.some((c) => c.method === "POST")).toBe(false);
      expect(forgeState.comments.find((c) => c.id === 42)?.body).toBe(`${marker}\n\na newer plan`);
      expect(forgeState.comments.find((c) => c.id === 7)?.body).toBe("lgtm");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("finds its comment past the first page", async () => {
    stubPrEnv("");
    for (let i = 0; i < 100; i++) forgeState.comments.push({ id: i + 1, pr: 5, body: `chatter ${i}` });
    forgeState.comments.push({ id: 500, pr: 5, body: `${marker}\n\nold` });
    try {
      await reconcilePr({ env: "app", mode: "comment", body: "new" });
      expect(forgeCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "GET https://api.github.com/repos/acme/infra/issues/5/comments?per_page=100&page=1",
        "GET https://api.github.com/repos/acme/infra/issues/5/comments?per_page=100&page=2",
        "PATCH https://api.github.com/repos/acme/infra/issues/comments/500",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("defaults to github.com's API base when GITHUB_API_URL is unset (plain GitHub run)", async () => {
    stubPrEnv("");
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "the plan" });
      expect(forgeCalls[0].url).toBe("https://api.github.com/repos/acme/infra/issues/5/comments?per_page=100&page=1");
      expect(forgeCalls[0].authorization).toBe("Bearer forgejo-actions-token");
      expect(result.commentUrl).toBe("https://github.com/acme/infra/issues/5#issuecomment-1000");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("sends the resolved token itself, Forgejo's way, CHANT_FORGEJO_TOKEN taking priority", async () => {
    stubPrEnv("http://forgejo.example/api/v1");
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "cross-instance-token");
    try {
      await reconcilePr({ env: "app", mode: "comment", body: "the plan" });
      expect(forgeCalls.length).toBeGreaterThan(0);
      for (const call of forgeCalls) expect(call.authorization).toBe("token cross-instance-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("FORGEJO_ACTIONS marks a Forgejo run whatever its API base looks like", async () => {
    stubPrEnv("https://code.example/api/forgejo");
    vi.stubEnv("FORGEJO_ACTIONS", "true");
    try {
      await reconcilePr({ env: "app", mode: "comment", body: "the plan" });
      expect(forgeCalls[0].url).toContain("limit=50");
      expect(forgeCalls[0].authorization).toBe("token forgejo-actions-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a refused write fails the step with the forge's status and the token's source", async () => {
    stubPrEnv("http://forgejo.example/api/v1");
    forgeState.failWith = 401;
    try {
      await expect(reconcilePr({ env: "app", mode: "comment", body: "the plan" })).rejects.toThrow(
        /answered 401.*token is required.*token from GH_TOKEN/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a pull request with no token at all is refused by name, before any call", async () => {
    stubPrEnv("http://forgejo.example/api/v1");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    try {
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        noCommentTokenMessage(repo, 5),
      );
      expect(forgeCalls).toHaveLength(0);
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("githubShapedForgeFrom (#3757)", () => {
  const token = { value: "t", source: "GH_TOKEN" };

  test("github.com and GHES bases get the GitHub client", () => {
    expect(githubShapedForgeFrom({}, "acme/infra", token).kind).toBe("github");
    expect(githubShapedForgeFrom({ GITHUB_API_URL: "https://ghe.example/api/v3" }, "acme/infra", token).kind).toBe("github");
  });

  test("an /api/v1 base, FORGEJO_ACTIONS or GITEA_ACTIONS gets the Forgejo client", () => {
    expect(githubShapedForgeFrom({ GITHUB_API_URL: "http://forgejo:3000/api/v1/" }, "a/b", token).kind).toBe("forgejo");
    expect(githubShapedForgeFrom({ FORGEJO_ACTIONS: "true" }, "a/b", token).kind).toBe("forgejo");
    expect(githubShapedForgeFrom({ GITEA_ACTIONS: "true" }, "a/b", token).kind).toBe("forgejo");
  });

  test("a Forgejo client is named by its API host", () => {
    expect(githubShapedForgeFrom({ GITHUB_API_URL: "http://forgejo:3000/api/v1" }, "a/b", token).host).toBe("forgejo:3000");
  });
});

// ── The GitLab merge-request note (#2256) ───────────────────────────────────

describe("mergeRequestContextFrom (#2256)", () => {
  const gitlabEnv = {
    CI_API_V4_URL: "https://gitlab.com/api/v4",
    CI_PROJECT_ID: "42",
    CI_PROJECT_PATH: "acme/infra",
    CI_PROJECT_URL: "https://gitlab.com/acme/infra",
    CI_MERGE_REQUEST_IID: "7",
  };

  test("reads the merge request off a merge_request_event pipeline", () => {
    expect(mergeRequestContextFrom(gitlabEnv)).toEqual({
      api: "https://gitlab.com/api/v4",
      project: "42",
      iid: 7,
      path: "acme/infra",
      webUrl: "https://gitlab.com/acme/infra",
    });
  });

  test("prefers the merge request's own project over the pipeline's", () => {
    // A merge request from a fork runs its pipeline in the fork's project,
    // and the note belongs on the target project's merge request.
    expect(
      mergeRequestContextFrom({ ...gitlabEnv, CI_MERGE_REQUEST_PROJECT_ID: "9" })?.project,
    ).toBe("9");
  });

  test("derives the API base from CI_SERVER_URL when CI_API_V4_URL is unset", () => {
    const { CI_API_V4_URL: _drop, ...rest } = gitlabEnv;
    expect(mergeRequestContextFrom({ ...rest, CI_SERVER_URL: "https://gl.example.com" })?.api).toBe(
      "https://gl.example.com/api/v4",
    );
  });

  test("a push or scheduled GitLab pipeline has no merge request", () => {
    const { CI_MERGE_REQUEST_IID: _drop, ...rest } = gitlabEnv;
    expect(mergeRequestContextFrom(rest)).toBeUndefined();
    expect(mergeRequestContextFrom({ ...rest, CI_MERGE_REQUEST_IID: "" })).toBeUndefined();
    expect(mergeRequestContextFrom({ ...rest, CI_MERGE_REQUEST_IID: "not-a-number" })).toBeUndefined();
  });

  test("a GitHub Actions run is not mistaken for a GitLab one", () => {
    expect(mergeRequestContextFrom({ GITHUB_REPOSITORY: "INTENTIUS/chant", GITHUB_REF: "refs/pull/1/merge" })).toBeUndefined();
  });
});

describe("gitlabNoteTokenFrom (#2256)", () => {
  test("a project or personal access token is sent as PRIVATE-TOKEN", () => {
    expect(gitlabNoteTokenFrom({ GITLAB_TOKEN: "glpat-x" })).toEqual({
      header: "PRIVATE-TOKEN",
      value: "glpat-x",
      source: "GITLAB_TOKEN",
    });
  });

  test("CHANT_GITLAB_TOKEN wins over GITLAB_TOKEN, which wins over the job token", () => {
    expect(
      gitlabNoteTokenFrom({ CHANT_GITLAB_TOKEN: "a", GITLAB_TOKEN: "b", CI_JOB_TOKEN: "c" })?.source,
    ).toBe("CHANT_GITLAB_TOKEN");
    expect(gitlabNoteTokenFrom({ GITLAB_TOKEN: "b", CI_JOB_TOKEN: "c" })?.source).toBe("GITLAB_TOKEN");
  });

  test("the job token is sent as JOB-TOKEN, which is a different header", () => {
    expect(gitlabNoteTokenFrom({ CI_JOB_TOKEN: "c" })).toEqual({
      header: "JOB-TOKEN",
      value: "c",
      source: "CI_JOB_TOKEN",
    });
  });

  test("no token at all is undefined rather than an empty header", () => {
    expect(gitlabNoteTokenFrom({})).toBeUndefined();
    expect(gitlabNoteTokenFrom({ GITLAB_TOKEN: "", CI_JOB_TOKEN: "" })).toBeUndefined();
  });
});

/** One stubbed GitLab REST response. */
function gitlabResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("reconcilePr comment mode on GitLab posts one merge-request note (#2256)", () => {
  const gitlabEnv: Record<string, string> = {
    CI_API_V4_URL: "https://gitlab.com/api/v4",
    CI_PROJECT_ID: "42",
    CI_PROJECT_PATH: "acme/infra",
    CI_PROJECT_URL: "https://gitlab.com/acme/infra",
    CI_MERGE_REQUEST_IID: "7",
    GITLAB_TOKEN: "glpat-x",
  };

  function stubGitlabEnv(): void {
    for (const [k, v] of Object.entries(gitlabEnv)) vi.stubEnv(k, v);
    // A GitLab job carries none of GitHub's variables; make that explicit so
    // the GitHub path can never be the one under test here.
    for (const k of ["GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_PATH"]) vi.stubEnv(k, "");
  }

  test("POSTs a new note carrying the marker as its first line", async () => {
    stubGitlabEnv();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") return gitlabResponse([]);
      return gitlabResponse({ id: 555 });
    });
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "the plan" });
      expect(result.commentUrl).toBe("https://gitlab.com/acme/infra/-/merge_requests/7#note_555");
      expect(result.mergeRequest).toBe("acme/infra!7");
      const post = calls[calls.length - 1];
      expect(post.url).toBe("https://gitlab.com/api/v4/projects/42/merge_requests/7/notes");
      expect(post.init?.method).toBe("POST");
      expect((post.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
      expect(JSON.parse(String(post.init?.body)).body).toBe(
        "<!-- chant-reconcile:app -->\n\nthe plan",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("PUTs the note it already owns instead of stacking a second one", async () => {
    stubGitlabEnv();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") {
        return gitlabResponse([
          { id: 1, system: true, body: "changed the description" },
          { id: 2, system: false, body: "unrelated human note" },
          { id: 3, system: false, body: "<!-- chant-reconcile:app -->\n\nan older plan" },
        ]);
      }
      return gitlabResponse({ id: 3 });
    });
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "a newer plan" });
      const write = calls[calls.length - 1];
      expect(write.init?.method).toBe("PUT");
      expect(write.url).toBe("https://gitlab.com/api/v4/projects/42/merge_requests/7/notes/3");
      expect(result.commentUrl).toBe("https://gitlab.com/acme/infra/-/merge_requests/7#note_3");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("follows GitLab's own pagination rather than reading page one alone", async () => {
    stubGitlabEnv();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        seen.push(url);
        if (url.endsWith("page=1")) return gitlabResponse([{ id: 1, body: "nope" }], { "x-next-page": "2" });
        return gitlabResponse([{ id: 9, body: "<!-- chant-reconcile:app -->\n\nold" }], { "x-next-page": "" });
      }
      return gitlabResponse({ id: 9 });
    });
    try {
      await reconcilePr({ env: "app", mode: "comment", body: "new" });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("page=2");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a rejected write fails the step by name, carrying GitLab's own status", async () => {
    stubGitlabEnv();
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return gitlabResponse([]);
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '{"message":"403 Forbidden"}',
      } as unknown as Response;
    });
    try {
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /merge_requests\/7\/notes.*403.*403 Forbidden/s,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a merge-request pipeline with no token says which variable to set", async () => {
    for (const [k, v] of Object.entries(gitlabEnv)) vi.stubEnv(k, k === "GITLAB_TOKEN" ? "" : v);
    vi.stubEnv("CI_JOB_TOKEN", "");
    vi.stubEnv("CHANT_GITLAB_TOKEN", "");
    try {
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /GITLAB_TOKEN.*CI_JOB_TOKEN/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the no-context refusal names both forges' variables (#2256)", () => {
  test("a run on neither forge is told what GitLab would have set too", async () => {
    for (const k of [
      "GITHUB_REPOSITORY",
      "GITHUB_REF",
      "GITHUB_EVENT_PATH",
      "CI_MERGE_REQUEST_IID",
      "CI_PROJECT_ID",
      "CI_API_V4_URL",
    ]) {
      vi.stubEnv(k, "");
    }
    try {
      await expect(reconcilePr({ env: "app", mode: "comment", body: "plan" })).rejects.toThrow(
        /CI_MERGE_REQUEST_IID/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── The GitLab issue (#2292) ─────────────────────────────────────────────

describe("issueMarker (#2292, #2319)", () => {
  test("deterministic per Op and env, and distinct from the comment-mode marker for the same env", () => {
    expect(issueMarker("nightly", "app")).toBe("<!-- chant-reconcile-issue:nightly/app -->");
    expect(issueMarker("nightly", "app")).toBe(issueMarker("nightly", "app"));
    expect(issueMarker("nightly", "app")).not.toBe(commentMarker("app"));
  });

  test("slugifies both halves the same way commentMarker does", () => {
    const marker = issueMarker('drift" watch', 'us-east/1" or true; #');
    expect(marker).toBe("<!-- chant-reconcile-issue:drift-watch/us-east-1-or-true- -->");
    expect(marker).not.toMatch(/["'\\]/);
  });

  // #2319: the whole point. Before this, both of these rendered
  // `<!-- chant-reconcile-issue:app -->` and each Op's nightly run PATCHed the
  // title and body of the other Op's issue.
  test("two Ops over one env get two markers", () => {
    expect(issueMarker("app-drift", "app")).not.toBe(issueMarker("app-drift-live", "app"));
  });

  test("the Op/env split is unambiguous: neither half can contain the separator", () => {
    // `a/b` as an Op name and `a` + `/b` as a boundary shift would alias if
    // `/` survived the slugify. It does not, so the marker parses back to
    // exactly one Op and one env.
    expect(issueMarker("a/b", "c")).toBe("<!-- chant-reconcile-issue:a-b/c -->");
    expect(issueMarker("a", "b/c")).toBe("<!-- chant-reconcile-issue:a/b-c -->");
    expect(issueMarker("a/b", "c")).not.toBe(issueMarker("a", "b/c"));
  });

  // The migration stance, as an assertion rather than a claim in a comment: a
  // marker from before #2319 and a marker from after never prefix-match each
  // other in either direction, so neither adopts the other's issue.
  test("no pre-#2319 marker prefix-matches a post-#2319 one, or the reverse", () => {
    const legacy = "<!-- chant-reconcile-issue:app -->";
    const current = issueMarker("nightly", "app");
    expect(`${current}\n\nbody`.startsWith(legacy)).toBe(false);
    expect(`${legacy}\n\nbody`.startsWith(current)).toBe(false);
  });
});

// ── The marker has to name an Op (#2319) ────────────────────────────────────

describe("reconcilePr issue mode refuses a step with no Op identity (#2319)", () => {
  function stubAnyCi(): void {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    // A token, so what these tests prove is the identity refusal (#2319) and
    // not the token refusal (#2320) standing in front of it.
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ghs-ambient");
  }

  test("names the mode, the env it was given, and both ways to fix the step", async () => {
    stubAnyCi();
    try {
      await expect(reconcilePr({ env: "app", mode: "issue", body: "plan" })).rejects.toThrow(
        /mode "issue".*env "app".*`op`.*`marker`/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("refuses before any call, so nothing runs on the way to failing", async () => {
    stubAnyCi();
    try {
      await expect(reconcilePr({ env: "app", mode: "issue", body: "plan" })).rejects.toThrow();
      expect(ghCalls).toHaveLength(0);
      expect(forgeCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The shape that actually reaches the plan derivation: no `body` and no
  // `entries`, which is `ReconcileOp`'s own step and the realistic
  // hand-written one. The refusal used to live inside the `issue` branch,
  // below `derivePlanEntries`, so this shape ran `chant lifecycle plan` first
  // and could fail with a plan error instead of the named refusal.
  test("refuses ahead of `chant lifecycle plan`, not after it", async () => {
    stubAnyCi();
    try {
      await expect(reconcilePr({ env: "app", mode: "issue", owned: true })).rejects.toThrow(
        /mode "issue".*env "app"/s,
      );
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // #2319 pre-merge review. `""` is not `undefined`, so it satisfied the
  // identity check, and `??` kept it — producing `startswith("")`, true of
  // every issue body in the repository. The step then PATCHed the title and
  // body of whichever OPEN non-pull-request issue the forge listed first.
  for (const blank of ["", "   ", "\t\n"]) {
    test(`a blank marker (${JSON.stringify(blank)}) is no marker, not an identity`, async () => {
      stubAnyCi();
      // A human's issue, first in the list: what `startswith("")` would match.
      forgeState.issues.push({ number: 42, title: "mine", body: "a human's issue", state: "open" });
      try {
        await expect(
          reconcilePr({ env: "app", marker: blank, mode: "issue", body: "plan" }),
        ).rejects.toThrow(noIssueIdentityMessage("app"));
        expect(forgeCalls).toHaveLength(0);
        expect(forgeState.issues[0].body).toBe("a human's issue");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }

  test("a blank marker alongside an op falls back to the op's marker, not to matching everything", async () => {
    stubAnyCi();
    forgeState.issues.push({ number: 1, title: "mine", body: "a human's issue", state: "open" });
    try {
      await reconcilePr({ env: "app", op: "nightly", marker: "  ", mode: "issue", body: "plan" });
      expect(forgeState.issues[0].body).toBe("a human's issue");
      expect(forgeState.issues[1].body).toBe("<!-- chant-reconcile-issue:nightly/app -->\n\nplan");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a blank op is no identity either", async () => {
    stubAnyCi();
    try {
      await expect(
        reconcilePr({ env: "app", op: "   ", mode: "issue", body: "plan" }),
      ).rejects.toThrow(noIssueIdentityMessage("app"));
      expect(ghCalls).toHaveLength(0);
      expect(forgeCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("comment mode treats a blank marker as absent too, rather than matching every comment", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_REF", "refs/pull/7/merge");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GH_TOKEN", "ghs-x");
    forgeState.comments.push({ id: 1, pr: 7, body: "lgtm" });
    try {
      await reconcilePr({ env: "app", marker: "", mode: "comment", body: "plan" });
      expect(forgeState.comments[0].body).toBe("lgtm");
      expect(forgeState.comments[1].body).toBe("<!-- chant-reconcile:app -->\n\nplan");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test("an explicit marker satisfies the requirement without an op", async () => {
    stubAnyCi();
    try {
      await reconcilePr({ env: "app", marker: "<!-- mine -->", mode: "issue", body: "plan" });
      expect(forgeState.issues[0].body).toBe("<!-- mine -->\n\nplan");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the refusal covers the ambient `gh issue create` fallback too, not just the CI paths", async () => {
    for (const k of ["GITHUB_REPOSITORY", "CI_PROJECT_ID", "CI_MERGE_REQUEST_IID"]) vi.stubEnv(k, "");
    ghReplies = [{ match: "gh issue create", stdout: "https://github.com/acme/infra/issues/3\n" }];
    try {
      await expect(reconcilePr({ env: "app", mode: "issue", body: "plan" })).rejects.toThrow(/mode "issue"/);
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("comment mode is untouched by the requirement — its marker is scoped to one pull request", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_REF", "refs/pull/7/merge");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GH_TOKEN", "ghs-x");
    try {
      const result = await reconcilePr({ env: "app", mode: "comment", body: "plan" });
      expect(result.commentUrl).toBe("https://github.com/acme/infra/issues/7#issuecomment-1000");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── A supplied marker has to survive the jq filter (#2319 review) ───────────

describe("suppliedMarker rejects what the search filter cannot carry (#2319)", () => {
  test("blank is absent, printable text is kept and trimmed", () => {
    expect(suppliedMarker(undefined)).toBeUndefined();
    expect(suppliedMarker("")).toBeUndefined();
    expect(suppliedMarker("  \t\n ")).toBeUndefined();
    expect(suppliedMarker("  <!-- mine -->  ")).toBe("<!-- mine -->");
  });

  for (const bad of ['<!-- a" -->', "<!-- a\\b -->", "<!-- a\nb -->"]) {
    test(`refuses ${JSON.stringify(bad)} by name`, () => {
      expect(() => suppliedMarker(bad)).toThrow(/cannot use/);
      expect(() => suppliedMarker(bad)).toThrow(unsafeMarkerMessage(bad.trim()));
    });
  }

  test("the refusal is raised through reconcilePr before any shell-out", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    try {
      await expect(
        reconcilePr({ env: "app", marker: '<!-- ") | not -->', mode: "issue", body: "plan" }),
      ).rejects.toThrow(/cannot use/);
      expect(ghCalls).toHaveLength(0);
      expect(forgeCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("what issueMarker itself builds always survives it", () => {
    const marker = issueMarker('drift" watch\\', 'us-east/1" or true; #');
    expect(suppliedMarker(marker)).toBe(marker);
  });

});

describe("gitlabProjectContextFrom (#2292)", () => {
  const gitlabEnv = {
    CI_API_V4_URL: "https://gitlab.com/api/v4",
    CI_PROJECT_ID: "42",
    CI_PROJECT_PATH: "acme/infra",
    CI_PROJECT_URL: "https://gitlab.com/acme/infra",
  };

  test("reads the project off any GitLab CI job, with no merge request in sight", () => {
    expect(gitlabProjectContextFrom(gitlabEnv)).toEqual({
      api: "https://gitlab.com/api/v4",
      project: "42",
      path: "acme/infra",
      webUrl: "https://gitlab.com/acme/infra",
    });
  });

  test("derives the API base from CI_SERVER_URL when CI_API_V4_URL is unset", () => {
    const { CI_API_V4_URL: _drop, ...rest } = gitlabEnv;
    expect(gitlabProjectContextFrom({ ...rest, CI_SERVER_URL: "https://gl.example.com" })?.api).toBe(
      "https://gl.example.com/api/v4",
    );
  });

  test("a GitHub Actions run is not mistaken for a GitLab one", () => {
    expect(
      gitlabProjectContextFrom({ GITHUB_REPOSITORY: "INTENTIUS/chant", GITHUB_REF: "refs/pull/1/merge" }),
    ).toBeUndefined();
  });

  test("no CI_PROJECT_ID at all is undefined", () => {
    expect(gitlabProjectContextFrom({})).toBeUndefined();
    expect(gitlabProjectContextFrom({ CI_PROJECT_ID: "" })).toBeUndefined();
  });
});

describe("reconcilePr issue mode on GitLab opens/updates one issue (#2292)", () => {
  const gitlabEnv: Record<string, string> = {
    CI_API_V4_URL: "https://gitlab.com/api/v4",
    CI_PROJECT_ID: "42",
    CI_PROJECT_PATH: "acme/infra",
    CI_PROJECT_URL: "https://gitlab.com/acme/infra",
    GITLAB_TOKEN: "glpat-x",
  };

  function stubGitlabEnv(): void {
    for (const [k, v] of Object.entries(gitlabEnv)) vi.stubEnv(k, v);
    // Neither GitHub's variables nor a merge-request iid are set on a plain
    // GitLab CI job (cron or push); make that explicit so the GitHub path and
    // the note path can never be the ones under test here.
    for (const k of ["GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_PATH", "CI_MERGE_REQUEST_IID"]) {
      vi.stubEnv(k, "");
    }
  }

  test("POSTs a new issue carrying the marker as the description's first line", async () => {
    stubGitlabEnv();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") return gitlabResponse([]);
      return gitlabResponse({ iid: 9 });
    });
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "the plan" });
      expect(result.issueUrl).toBe("https://gitlab.com/acme/infra/-/issues/9");
      const post = calls[calls.length - 1];
      expect(post.url).toBe("https://gitlab.com/api/v4/projects/42/issues");
      expect(post.init?.method).toBe("POST");
      expect((post.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
      const sent = JSON.parse(String(post.init?.body));
      expect(sent.description).toBe("<!-- chant-reconcile-issue:nightly/app -->\n\nthe plan");
      expect(sent.title).toContain("Reconcile app");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("PUTs the issue it already owns instead of opening a second one", async () => {
    stubGitlabEnv();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") {
        return gitlabResponse([
          { iid: 1, description: "unrelated issue" },
          { iid: 4, description: "<!-- chant-reconcile-issue:nightly/app -->\n\nan older finding" },
        ]);
      }
      return gitlabResponse({ iid: 4 });
    });
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "a newer finding" });
      const write = calls[calls.length - 1];
      expect(write.init?.method).toBe("PUT");
      expect(write.url).toBe("https://gitlab.com/api/v4/projects/42/issues/4");
      expect(result.issueUrl).toBe("https://gitlab.com/acme/infra/-/issues/4");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("searches narrowly by marker rather than paging every issue the project has", async () => {
    stubGitlabEnv();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        seen.push(url);
        return gitlabResponse([]);
      }
      return gitlabResponse({ iid: 9 });
    });
    try {
      await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "new" });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`search=${encodeURIComponent(issueMarker("nightly", "app"))}`);
      expect(seen[0]).toContain("in=description");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a rejected write fails the step by name, carrying GitLab's own status", async () => {
    stubGitlabEnv();
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return gitlabResponse([]);
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '{"message":"403 Forbidden"}',
      } as unknown as Response;
    });
    try {
      await expect(reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" })).rejects.toThrow(
        /projects\/42\/issues.*403.*403 Forbidden/s,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a GitLab run with no token names the mode, the project, and every variable it looked for", async () => {
    for (const [k, v] of Object.entries(gitlabEnv)) vi.stubEnv(k, k === "GITLAB_TOKEN" ? "" : v);
    vi.stubEnv("CI_JOB_TOKEN", "");
    vi.stubEnv("CHANT_GITLAB_TOKEN", "");
    for (const k of ["GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_PATH", "CI_MERGE_REQUEST_IID"]) {
      vi.stubEnv(k, "");
    }
    try {
      await expect(reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" })).rejects.toThrow(
        /mode "issue".*project 42.*GITLAB_TOKEN.*CI_JOB_TOKEN/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── The GitHub/GHES/Forgejo sticky issue (#2297) ────────────────────────────

describe("reconcilePr issue mode on GitHub/GHES/Forgejo opens/updates one issue (#2297, #3757)", () => {
  const repo = "acme/infra";
  const marker = "<!-- chant-reconcile-issue:nightly/app -->";

  function stubGithubIssueEnv(apiUrl: string): void {
    vi.stubEnv("GITHUB_REPOSITORY", repo);
    vi.stubEnv("GITHUB_API_URL", apiUrl);
    // What a GitHub Actions or Forgejo Actions job sets from `github.token`.
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ghs-ambient");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("FORGEJO_ACTIONS", "");
    vi.stubEnv("GITEA_ACTIONS", "");
    // Never the GitLab path or the comment/PR path.
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
  }

  test("POSTs a new issue carrying the marker as the body's first line", async () => {
    stubGithubIssueEnv("http://forgejo.example/api/v1");
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "the plan" });
      expect(result.issueUrl).toBe("http://forgejo.example/acme/infra/issues/1");
      expect(forgeCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "GET http://forgejo.example/api/v1/repos/acme/infra/issues?state=open&limit=50&page=1",
        "POST http://forgejo.example/api/v1/repos/acme/infra/issues",
      ]);
      expect(forgeCalls[1].body).toEqual({ title: "Reconcile app: 0 change(s) from live", body: `${marker}\n\nthe plan` });
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a re-run PATCHes the issue it already owns, title and body, instead of opening a second", async () => {
    stubGithubIssueEnv("http://forgejo.example/api/v1");
    forgeState.issues.push(
      { number: 1, title: "a human's issue", body: "unrelated", state: "open", pull_request: null },
      { number: 2, title: "old", body: `${marker}\n\nold plan`, state: "open", pull_request: null },
    );
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", title: "Drift: 3", body: "a newer plan" });
      expect(result.issueUrl).toBe("http://forgejo.example/acme/infra/issues/2");
      expect(forgeCalls.at(-1)).toMatchObject({
        method: "PATCH",
        url: "http://forgejo.example/api/v1/repos/acme/infra/issues/2",
        body: { title: "Drift: 3", body: `${marker}\n\na newer plan` },
      });
      expect(forgeCalls.some((c) => c.method === "POST")).toBe(false);
      expect(forgeState.issues[0].body).toBe("unrelated");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("searches only OPEN issues, and never mistakes a pull request for one it owns", async () => {
    stubGithubIssueEnv("");
    forgeState.issues.push(
      { number: 1, title: "closed by hand", body: `${marker}\n\nfixed`, state: "closed", pull_request: null },
      { number: 2, title: "a PR quoting it", body: `${marker}\n\nquoted`, state: "open", pull_request: { url: "x" } },
    );
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(forgeCalls[0].url).toBe("https://api.github.com/repos/acme/infra/issues?state=open&per_page=100&page=1");
      expect(result.issueUrl).toBe("https://github.com/acme/infra/issues/3");
      expect(forgeCalls.some((c) => c.method === "PATCH")).toBe(false);
      expect(forgeState.issues[0].state).toBe("closed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("falls back to gh issue create, still marker-prefixed, outside any known CI job", async () => {
    // Neither GITHUB_REPOSITORY nor CI_PROJECT_ID: a local or manual run.
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    ghReplies = [{ match: "gh issue create", stdout: "https://github.com/acme/infra/issues/3\n" }];
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(result.issueUrl).toBe("https://github.com/acme/infra/issues/3");
      expect(ghCalls).toHaveLength(1);
      expect(ghCalls[0].cmd).toContain("gh issue create");
      expect(ghCalls[0].cmd).toContain(`${marker}\n\nplan`);
      expect(forgeCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("GitLab takes priority when both a GitLab and a GitHub signal are somehow present", async () => {
    stubGithubIssueEnv("");
    vi.stubEnv("CI_PROJECT_ID", "42");
    vi.stubEnv("CI_API_V4_URL", "https://gitlab.com/api/v4");
    vi.stubEnv("GITLAB_TOKEN", "glpat-x");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") return gitlabResponse([]);
      return gitlabResponse({ iid: 5 });
    });
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(result.issueUrl).toBe("https://gitlab.com/api/v4/projects/42/issues/5");
      expect(calls.every((c) => c.url.startsWith("https://gitlab.com/api/v4/"))).toBe(true);
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

// ── The two-Op proof #2319 asked for ────────────────────────────────────────

describe("two Ops over one env keep two issues, end to end (#2319)", () => {
  // The fake forge holds what each run wrote, so run B searches the issue run
  // A actually opened rather than a reply restated for the test.
  function stubRepo(): void {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ghs-ambient");
  }

  test("run B does not find run A's issue and opens its own; A's next run edits A's", async () => {
    stubRepo();
    try {
      // Run A: the stock drift watch over root "app". Nothing owned yet.
      const a = await reconcilePr({ env: "app", op: "app-drift", mode: "issue", body: "finding from A" });
      expect(a.issueUrl).toBe("https://github.com/acme/infra/issues/1");

      // Run B: the `live: true` watch over the same root. Same `env`, the
      // pairing #2319 reports. Before #2319 B's marker matched A's issue and
      // B rewrote it.
      const b = await reconcilePr({ env: "app", op: "app-drift-live", mode: "issue", body: "finding from B" });
      expect(b.issueUrl).toBe("https://github.com/acme/infra/issues/2");
      expect(forgeState.issues[0].body).toContain("finding from A");
      expect(forgeState.issues[0].body).not.toContain("finding from B");

      // A again: stickiness preserved, not just two strangers.
      const a2 = await reconcilePr({ env: "app", op: "app-drift", mode: "issue", body: "finding from A, later" });
      expect(a2.issueUrl).toBe("https://github.com/acme/infra/issues/1");
      expect(forgeState.issues).toHaveLength(2);
      expect(forgeState.issues[0].body).toContain("finding from A, later");
      expect(forgeState.issues[1].body).toContain("finding from B");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── The issue path's credential (#2320) ─────────────────────────────────────

describe("reconcilePr issue mode sends the token it resolved (#2320)", () => {
  function stubForgejoIssueEnv(): void {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_API_URL", "https://other.forgejo.example/api/v1");
    vi.stubEnv("CI_PROJECT_ID", "");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
  }

  // The case `noCommentTokenMessage` was written for, on the mode that never
  // sent it: a run posting to a Forgejo instance other than the one the job
  // executes on, where the job's own `github.token` stops at its own host.
  test("CHANT_FORGEJO_TOKEN is the one sent, on every call, outranking the ambient one", async () => {
    stubForgejoIssueEnv();
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "forgejo-cross-instance");
    vi.stubEnv("GH_TOKEN", "ghs-this-instance-only");
    forgeState.issues.push({ number: 1, title: "t", body: "<!-- chant-reconcile-issue:nightly/app -->\n\nold", state: "open" });
    try {
      await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(forgeCalls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
      for (const call of forgeCalls) expect(call.authorization).toBe("token forgejo-cross-instance");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("falls back to GH_TOKEN then GITHUB_TOKEN, the same order comment mode uses", async () => {
    stubForgejoIssueEnv();
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "ghs-workflow");
    try {
      await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(forgeCalls[0].authorization).toBe("token ghs-workflow");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("no token at all is chant's named refusal, before any call", async () => {
    stubForgejoIssueEnv();
    for (const k of ["CHANT_FORGEJO_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(k, "");
    try {
      await expect(
        reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" }),
      ).rejects.toThrow(/mode "issue".*acme\/infra.*CHANT_FORGEJO_TOKEN/s);
      expect(forgeCalls).toHaveLength(0);
      expect(ghCalls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the refusal names the issue mode, not the comment mode's pull request", async () => {
    stubForgejoIssueEnv();
    for (const k of ["CHANT_FORGEJO_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(k, "");
    try {
      const err = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" }).catch(
        (e: Error) => e,
      );
      expect((err as Error).message).toBe(noIssueTokenMessage("acme/infra"));
      expect((err as Error).message).not.toContain("pull request");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The one path deliberately left on gh's own ambient credential: outside
  // every CI job, `gh auth login`'s stored token is the token, and
  // commentTokenFrom cannot see it.
  test("the ambient `gh issue create` fallback still runs with no token set", async () => {
    for (const k of [
      "GITHUB_REPOSITORY",
      "CI_PROJECT_ID",
      "CI_MERGE_REQUEST_IID",
      "CHANT_FORGEJO_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      vi.stubEnv(k, "");
    }
    ghReplies = [{ match: "gh issue create", stdout: "https://github.com/acme/infra/issues/3\n" }];
    try {
      const result = await reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" });
      expect(result.issueUrl).toBe("https://github.com/acme/infra/issues/3");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("GitLab keeps its own credential path, untouched by this", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("CI_PROJECT_ID", "42");
    vi.stubEnv("CI_API_V4_URL", "https://gitlab.com/api/v4");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "");
    vi.stubEnv("GITLAB_TOKEN", "");
    vi.stubEnv("CI_JOB_TOKEN", "");
    vi.stubEnv("CHANT_GITLAB_TOKEN", "");
    // A Forgejo token is not a GitLab credential and must not be read as one.
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "forgejo-cross-instance");
    try {
      await expect(
        reconcilePr({ env: "app", op: "nightly", mode: "issue", body: "plan" }),
      ).rejects.toThrow(/GITLAB_TOKEN/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("postOrUpdateGithubIssue directly (#2297)", () => {
  test("PATCHes with both title and body fields so the headline stays current", async () => {
    const calls: string[] = [];
    const exec = async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("--paginate")) return { stdout: "12\n", stderr: "" };
      return { stdout: "https://github.example/acme/infra/issues/12\n", stderr: "" };
    };
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("CHANT_FORGEJO_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ghs-ambient");
    try {
      const url = await postOrUpdateGithubIssue(
        "acme/infra",
        issueMarker("nightly", "app"),
        "Reconcile app: 3 change(s) from live",
        "the body",
        exec,
      );
      expect(url).toBe("https://github.example/acme/infra/issues/12");
      const patch = calls.find((c) => c.includes("--method PATCH"));
      expect(patch).toContain("title=Reconcile app: 3 change(s) from live");
      expect(patch).toContain("<!-- chant-reconcile-issue:nightly/app -->\n\nthe body");
      expect(patch).toContain("/repos/acme/infra/issues/12");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("reconcilePr pull-request mode tells gh the forge's host (#3780)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("on GitHub Enterprise Server, gh pr create runs with GH_HOST and the enterprise token", async () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://ghe.acme.internal");
    vi.stubEnv("GH_TOKEN", "job-token");
    vi.stubEnv("GH_HOST", "");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "");
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "");
    ghReplies = [{ match: "gh pr create", stdout: "https://ghe.acme.internal/acme/infra/pull/9\n" }];
    const result = await reconcilePr({ env: "prod", entries, mode: "pull-request" });
    expect(result.prUrl).toBe("https://ghe.acme.internal/acme/infra/pull/9");
    const create = ghCalls.find((c) => c.cmd.startsWith("gh pr create"))!;
    expect(create.opts.env?.GH_HOST).toBe("ghe.acme.internal");
    expect(create.opts.env?.GH_ENTERPRISE_TOKEN).toBe("job-token");
    // git keeps the process environment.
    expect(ghCalls.find((c) => c.cmd.startsWith("git push"))!.opts.env).toBeUndefined();
  });

  test("on github.com, gh pr create gets no GH_HOST", async () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    vi.stubEnv("GH_HOST", "");
    await reconcilePr({ env: "prod", entries, mode: "pull-request" });
    const create = ghCalls.find((c) => c.cmd.startsWith("gh pr create"))!;
    expect(create.opts.env?.GH_HOST ?? "").toBe("");
  });
});
