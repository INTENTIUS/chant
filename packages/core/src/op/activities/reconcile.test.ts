import { describe, test, expect, vi } from "vitest";
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
} from "./reconcile";

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

describe("issueMarker (#2292)", () => {
  test("deterministic per env, and distinct from the comment-mode marker for the same env", () => {
    expect(issueMarker("app")).toBe("<!-- chant-reconcile-issue:app -->");
    expect(issueMarker("app")).toBe(issueMarker("app"));
    expect(issueMarker("app")).not.toBe(commentMarker("app"));
  });

  test("slugifies the env the same way commentMarker does", () => {
    const marker = issueMarker('us-east/1" or true; #');
    expect(marker).toBe("<!-- chant-reconcile-issue:us-east-1-or-true- -->");
    expect(marker).not.toMatch(/["'\\]/);
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
      const result = await reconcilePr({ env: "app", mode: "issue", body: "the plan" });
      expect(result.issueUrl).toBe("https://gitlab.com/acme/infra/-/issues/9");
      const post = calls[calls.length - 1];
      expect(post.url).toBe("https://gitlab.com/api/v4/projects/42/issues");
      expect(post.init?.method).toBe("POST");
      expect((post.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
      const sent = JSON.parse(String(post.init?.body));
      expect(sent.description).toBe("<!-- chant-reconcile-issue:app -->\n\nthe plan");
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
          { iid: 4, description: "<!-- chant-reconcile-issue:app -->\n\nan older finding" },
        ]);
      }
      return gitlabResponse({ iid: 4 });
    });
    try {
      const result = await reconcilePr({ env: "app", mode: "issue", body: "a newer finding" });
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
      await reconcilePr({ env: "app", mode: "issue", body: "new" });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`search=${encodeURIComponent(issueMarker("app"))}`);
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
      await expect(reconcilePr({ env: "app", mode: "issue", body: "plan" })).rejects.toThrow(
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
      await expect(reconcilePr({ env: "app", mode: "issue", body: "plan" })).rejects.toThrow(
        /mode "issue".*project 42.*GITLAB_TOKEN.*CI_JOB_TOKEN/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
