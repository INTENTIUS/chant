import { describe, expect, test } from "vitest";
import type { ForgeFetch, PrForge, PullRequest, PullRequestSpec } from "../pr-forge";
import {
  CONTROL_TOKEN_ENV,
  ControlConfigError,
  ControlDispatchError,
  controlDependentsScript,
  controlDispatchJob,
  controlDispatchRequest,
  controlDispatchScript,
  controlPipelineSpec,
  controlSettingsProblems,
  dispatchControl,
  resolveControlTarget,
} from "./dispatch";
import {
  ControlEntryConflict,
  ControlRecordsError,
  controlConfig,
  estateClaims,
  importControlConfig,
  putControlEntry,
  readControlEntries,
  retireControlEntry,
  type ControlLedgerPort,
} from "./records";
import { describeReconcile, gitAuthEnv, reconcileProjects, type ControlGit } from "./reconcile";

const TOKEN = "s3cr3t-dispatch-token";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A forge that records each request and answers with `status`. */
function fakeForge(status = 204, answer = "") {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: status < 300, status, text: async () => answer };
  };
  return { calls, fetch };
}

describe("control dispatch per forge (#4568)", () => {
  test("GitHub: a repository_dispatch named by the product, the token in the Authorization header", async () => {
    const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network");
    const forge = fakeForge();
    await dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { token: TOKEN, fetch: forge.fetch, words: { product: "plywood" } });
    expect(forge.calls).toHaveLength(1);
    const call = forge.calls[0]!;
    expect(call.url).toBe("https://api.github.com/repos/acme/control/dispatches");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ event_type: "plywood-applied", client_payload: { member: "network", op: "deploy", sha: SHA } });
  });

  test("GitLab: a pipeline trigger with chant's variables, the token a form field", async () => {
    const target = resolveControlTarget({ repo: "gitlab.example.com/acme/infra/control", forge: "gitlab", op: "deploy", ref: "trunk" }, "network");
    const forge = fakeForge(201);
    await dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { token: TOKEN, fetch: forge.fetch });
    const call = forge.calls[0]!;
    expect(call.url).toBe("https://gitlab.example.com/api/v4/projects/acme%2Finfra%2Fcontrol/trigger/pipeline");
    const form = new URLSearchParams(call.body!);
    expect(form.get("token")).toBe(TOKEN);
    expect(form.get("ref")).toBe("trunk");
    expect(form.get("variables[CHANT_CONTROL_MEMBER]")).toBe("network");
    expect(form.get("variables[CHANT_CONTROL_SHA]")).toBe(SHA);
    expect(call.headers.Authorization).toBeUndefined();
  });

  test("Forgejo: a workflow dispatch of the product's dependents file", async () => {
    const target = resolveControlTarget({ repo: "codeberg.org/acme/control", op: "deploy" }, "network");
    const forge = fakeForge();
    await dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { token: TOKEN, fetch: forge.fetch, words: { product: "terragucci" } });
    const call = forge.calls[0]!;
    expect(call.url).toBe("https://codeberg.org/api/v1/repos/acme/control/actions/workflows/terragucci-dependents.yml/dispatches");
    expect(call.headers.Authorization).toBe(`token ${TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ ref: "main", inputs: { member: "network", op: "deploy", sha: SHA } });
  });

  test("a refusal throws with the status, and the token never appears in the message", async () => {
    const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network");
    const forge = fakeForge(403, `bad credentials ${TOKEN}`);
    const err = await dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { token: TOKEN, fetch: forge.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlDispatchError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(TOKEN);
  });

  test("the token is read from CHANT_CONTROL_TOKEN, and its absence sends nothing", async () => {
    const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network");
    const forge = fakeForge();
    await expect(dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { env: {}, fetch: forge.fetch })).rejects.toBeInstanceOf(ControlDispatchError);
    expect(forge.calls).toHaveLength(0);
    await dispatchControl(target, { member: "network", op: "deploy", sha: SHA }, { env: { [CONTROL_TOKEN_ENV]: TOKEN }, fetch: forge.fetch });
    expect(forge.calls).toHaveLength(1);
  });

  test("a sha that is not hex, or a member with a quote, is refused before any request", () => {
    const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network");
    expect(() => controlDispatchRequest(target, { member: "network", op: "deploy", sha: "HEAD; rm" })).toThrow(ControlConfigError);
    expect(() => controlDispatchRequest(target, { member: "net'work", op: "deploy", sha: SHA })).toThrow(ControlConfigError);
  });

  test("settings: a host that names no forge needs forge, and the read secret is never the dispatch secret", () => {
    expect(controlSettingsProblems({ repo: "git.example.com/acme/control", op: "deploy" })).toEqual([expect.stringContaining("control.forge is needed")]);
    expect(controlSettingsProblems({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "T", readTokenSecret: "T" })).toEqual([expect.stringContaining("must not be the dispatch token's secret")]);
  });
});

describe("control dispatch script (#4568)", () => {
  const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "PLYWOOD_CONTROL_TOKEN" }, "network");

  test("the token reaches curl on stdin, never its argv", () => {
    for (const forge of ["github", "gitlab", "forgejo"] as const) {
      const script = controlDispatchScript({ ...target, forge, apiBase: "https://forge.example.com/api" }, { words: { product: "plywood" } });
      expect(script).toContain(`"$${CONTROL_TOKEN_ENV}" | curl`);
      expect(script).not.toMatch(/curl[^\n]*\$CHANT_CONTROL_TOKEN/);
      expect(script).toContain("CHANT_CONTROL_SHA");
    }
  });

  test("the product's sent check and mark wrap the request", () => {
    const script = controlDispatchScript(target, { sentCheck: "plywood post sent plywood/control", markSent: "plywood post status plywood/control success" });
    expect(script.indexOf("plywood post sent")).toBeLessThan(script.indexOf("curl"));
    expect(script).toContain("; plywood post status plywood/control success");
  });

  test("the job maps the product's secret into CHANT_CONTROL_TOKEN for its one step", () => {
    const gh = controlDispatchJob("github", target, "${{ github.sha }}", { words: { product: "plywood" } });
    expect(gh.env).toEqual({ CHANT_CONTROL_TOKEN: "${{ secrets.PLYWOOD_CONTROL_TOKEN }}", CHANT_CONTROL_SHA: "${{ github.sha }}" });
    expect(gh.context).toBe("plywood/control");
    const gl = controlDispatchJob("gitlab", target, "$CI_COMMIT_SHA");
    expect(gl.env).toEqual({ CHANT_CONTROL_SHA: "$CI_COMMIT_SHA" });
    expect(gl.script.split("\n")[0]).toBe('CHANT_CONTROL_TOKEN="${PLYWOOD_CONTROL_TOKEN:-}"');
  });

  test("the control repo's pipeline checks the member and Op before they reach a command line", () => {
    const script = controlDependentsScript();
    expect(script).toContain("[[ $member =~ $re && $op =~ $re ]]");
    expect(script).toContain('workspace run --dependents-of "$member" --op "$op" --json');
    const spec = controlPipelineSpec("github", { product: "terragucci" });
    expect(spec.path).toBe(".github/workflows/terragucci-dependents.yml");
    expect(spec.event).toBe("terragucci-applied");
    expect(controlPipelineSpec("gitlab").path).toBe(".gitlab/chant-dependents.yml");
  });
});

/** A ledger in memory. */
function memoryLedger(): ControlLedgerPort & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    read: async () => (lines.length ? lines.join("\n") + "\n" : null),
    append: async (line) => {
      lines.push(line);
      return `commit-${lines.length}`;
    },
  };
}

const clock = () => new Date("2026-10-27T12:00:00.000Z");

describe("control-entry records on the ledger (#4568)", () => {
  test("create, update and leave unchanged, each a line with the digest it replaces", async () => {
    const ledger = memoryLedger();
    const opts = { product: "terragucci", now: clock };
    const a = await putControlEntry(ledger, { entry: "project", project: "github.com/acme/net", settings: { forge: "github" }, estates: ["net"] }, opts);
    expect(a).toMatchObject({ id: "ctl-001", status: "created", commit: "commit-1" });
    const b = await putControlEntry(ledger, { entry: "project", project: "github.com/acme/net", settings: { forge: "github" } }, opts);
    expect(b.status).toBe("unchanged");
    const c = await putControlEntry(ledger, { entry: "project", project: "github.com/acme/net", settings: { forge: "github", tips: true } }, opts);
    expect(c.status).toBe("updated");
    expect(c.record!.prev).toBe(a.record!.digest);
    expect(c.record!.estates).toEqual(["net"]);
    expect(ledger.lines).toHaveLength(2);
    const entries = await readControlEntries(ledger);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.settings).toEqual({ forge: "github", tips: true });
  });

  test("a write over a version it did not read is refused", async () => {
    const ledger = memoryLedger();
    const opts = { product: "plywood", now: clock };
    const a = await putControlEntry(ledger, { entry: "defaults", settings: { approvers: ["ops"] } }, opts);
    await putControlEntry(ledger, { entry: "defaults", settings: { approvers: ["ops", "sec"] } }, { ...opts, expect: a.record!.digest });
    await expect(putControlEntry(ledger, { entry: "defaults", settings: { approvers: [] } }, { ...opts, expect: a.record!.digest })).rejects.toBeInstanceOf(ControlEntryConflict);
  });

  test("a retired project is no longer read, and a tampered line refuses the read", async () => {
    const ledger = memoryLedger();
    const opts = { product: "terragucci", now: clock };
    await importControlConfig(ledger, { defaults: { tips: true }, projects: { "github.com/acme/a": {}, "gitlab.com/acme/b": {} }, estates: { "github.com/acme/a": ["shared"] } }, opts);
    await retireControlEntry(ledger, "gitlab.com/acme/b", opts);
    const entries = await readControlEntries(ledger);
    expect(controlConfig(entries)).toEqual({ defaults: { tips: true }, projects: { "github.com/acme/a": {} } });
    expect(estateClaims(entries).get("shared")).toEqual(["github.com/acme/a"]);
    ledger.lines[0] = ledger.lines[0]!.replace('"tips":true', '"tips":false');
    await expect(readControlEntries(ledger)).rejects.toBeInstanceOf(ControlRecordsError);
  });

  test("the product's check runs on write and on read", async () => {
    const ledger = memoryLedger();
    const validate = (_e: string, _p: string | undefined, s: Record<string, unknown>) => (typeof s.forge === "string" && s.forge !== "github" ? ["forge must be github"] : []);
    await expect(putControlEntry(ledger, { entry: "project", project: "github.com/acme/a", settings: { forge: "svn" } }, { product: "plywood", validate })).rejects.toBeInstanceOf(ControlRecordsError);
    expect(ledger.lines).toHaveLength(0);
  });
});

/** A forge that holds pull requests in memory. */
function fakePrForge() {
  const prs: PullRequest[] = [];
  const forge = {
    defaultBranch: async () => "trunk",
    findPullRequest: async (head: string) => prs.find((p) => p.head === head),
    editPullRequest: async (n: number, change: { title?: string; body?: string }) => {
      const pr = prs.find((p) => p.number === n)!;
      Object.assign(pr, change);
      return pr;
    },
    openPullRequest: async (spec: PullRequestSpec) => {
      const pr = { number: prs.length + 1, url: `https://forge.example/pr/${prs.length + 1}`, title: spec.title, body: spec.body, head: spec.head, base: spec.base };
      prs.push(pr);
      return pr;
    },
  } as unknown as PrForge;
  return { prs, forge };
}

/** git that records what it was asked. */
function fakeGit() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const git: ControlGit = {
    clone: async (...args) => {
      calls.push({ op: "clone", args });
    },
    commitAndPush: async (...args) => {
      calls.push({ op: "push", args });
    },
  };
  return { calls, git };
}

const work = { make: () => "/fake/work", remove: () => {} };

describe("reconcile over the product's generator (#4568)", () => {
  test("a dry run clones and asks the generator, and opens nothing", async () => {
    const { calls, git } = fakeGit();
    const { prs, forge } = fakePrForge();
    const out = await reconcileProjects([{ key: "github.com/acme/a", settings: {} }, { key: "github.com/acme/b", settings: {} }], {
      mode: "dry-run",
      git,
      workDir: work,
      forgeFor: () => forge,
      generate: async (_dir, t) => [{ path: ".github/workflows/plywood.yml", status: t.key.endsWith("/a") ? "updated" : "unchanged" }],
    });
    expect(out.map((o) => o.status)).toEqual(["would-change", "unchanged"]);
    expect(calls.filter((c) => c.op === "push")).toHaveLength(0);
    expect(prs).toHaveLength(0);
    expect(describeReconcile(out, "dry-run")).toContain("1 of 2 would change");
  });

  test("apply pushes the product's branch and opens a pull request against the default branch, then updates it", async () => {
    const { calls, git } = fakeGit();
    const { prs, forge } = fakePrForge();
    const opts = {
      mode: "apply" as const,
      words: { product: "plywood" },
      env: { CHANT_GITHUB_TOKEN: TOKEN },
      git,
      workDir: work,
      forgeFor: () => forge,
      generate: async () => [{ path: ".github/workflows/plywood.yml", status: "created" as const }],
    };
    const first = await reconcileProjects([{ key: "github.com/acme/a", settings: {} }], opts);
    expect(first[0]).toMatchObject({ status: "pull-request", pullRequest: "https://forge.example/pr/1" });
    expect(prs[0]).toMatchObject({ head: "plywood/pipeline", base: "trunk", title: "plywood: update the pipeline" });
    const push = calls.find((c) => c.op === "push")!;
    expect(push.args[1]).toBe("plywood/pipeline");
    expect(push.args[4]).toEqual({ user: "x-access-token", token: TOKEN });
    await reconcileProjects([{ key: "github.com/acme/a", settings: {} }], opts);
    expect(prs).toHaveLength(1);
  });

  test("a project without its token fails alone", async () => {
    const { git } = fakeGit();
    const { forge } = fakePrForge();
    const out = await reconcileProjects([{ key: "gitlab.com/acme/a", settings: {} }, { key: "github.com/acme/b", settings: {} }], {
      mode: "apply",
      env: { CHANT_GITHUB_TOKEN: TOKEN },
      git,
      workDir: work,
      forgeFor: () => forge,
      generate: async () => [{ path: "x", status: "created" }],
    });
    expect(out[0]).toMatchObject({ status: "failed", error: expect.stringContaining("CHANT_GITLAB_TOKEN is not set") });
    expect(out[1]!.status).toBe("pull-request");
  });

  test("git's token rides in the environment as an extraheader", () => {
    const env = gitAuthEnv({ user: "oauth2", token: TOKEN });
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`);
  });
});
