/**
 * #5469: whether the forge refuses force pushes to and deletions of
 * chant/lifecycle, read from recorded forge responses for GitHub, GitLab
 * and Forgejo, and the doctor check that reports it. Nothing reaches a forge.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFECYCLE_BRANCH, protectionVerdict, readLifecycleProtection, type ProtectionTarget } from "./lifecycle-protection";
import { releaseDoctor } from "./release-doctor";

type Answer = { status: number; body?: unknown };

/** A fetch that answers each request from a table of path suffixes, and records the requests. */
function recorded(table: Record<string, Answer>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const key = Object.keys(table).find((k) => url.endsWith(k));
    const a = key ? table[key]! : { status: 404, body: { message: "Not Found" } };
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? "" : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}

const GITHUB: ProtectionTarget = { kind: "github", apiBase: "https://api.github.com", repo: "acme/api", token: "ghp_x" };
const GITLAB: ProtectionTarget = { kind: "gitlab", apiBase: "https://gitlab.test/api/v4", repo: "acme/api", token: "glpat_x" };
const FORGEJO: ProtectionTarget = { kind: "forgejo", apiBase: "https://forge.test/api/v1", repo: "acme/api", token: "fj_x" };

const RULES = `/repos/acme/api/rules/branches/${LIFECYCLE_BRANCH}`;
const CLASSIC = `/repos/acme/api/branches/${LIFECYCLE_BRANCH}/protection`;

describe("GitHub", () => {
  test("a ruleset that blocks deletion and non-fast-forward updates protects the branch, with no admin read of classic protection", async () => {
    const { fetch, calls } = recorded({ [RULES]: { status: 200, body: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_signatures" }] }, [CLASSIC]: { status: 403, body: { message: "Resource not accessible" } } });
    const p = await readLifecycleProtection(GITHUB, fetch);
    expect(p).toMatchObject({ force: "refused", deletion: "refused" });
    expect(protectionVerdict(p).status).toBe("ok");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ghp_x");
  });

  test("classic branch protection that allows force pushes is reported, and so is no protection at all", async () => {
    const allowed = await readLifecycleProtection(GITHUB, recorded({ [RULES]: { status: 200, body: [] }, [CLASSIC]: { status: 200, body: { allow_force_pushes: { enabled: true }, allow_deletions: { enabled: false } } } }).fetch);
    expect(allowed).toMatchObject({ force: "allowed", deletion: "refused" });
    expect(protectionVerdict(allowed)).toMatchObject({ status: "warn", message: expect.stringContaining("force pushes of chant/lifecycle") });
    const none = await readLifecycleProtection(GITHUB, recorded({ [RULES]: { status: 200, body: [] }, [CLASSIC]: { status: 404, body: { message: "Branch not protected" } } }).fetch);
    expect(none).toMatchObject({ force: "allowed", deletion: "allowed" });
    expect(protectionVerdict(none).message).toContain("force pushes or deletions");
    const classic = await readLifecycleProtection(GITHUB, recorded({ [RULES]: { status: 200, body: [] }, [CLASSIC]: { status: 200, body: { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } } } }).fetch);
    expect(protectionVerdict(classic).status).toBe("ok");
  });

  test("a token that reads neither is unknown, and a forge that can't be reached is too", async () => {
    const denied = await readLifecycleProtection(GITHUB, recorded({ [RULES]: { status: 403 }, [CLASSIC]: { status: 403 } }).fetch);
    expect(denied).toMatchObject({ force: "unknown", deletion: "unknown" });
    expect(protectionVerdict(denied)).toMatchObject({ status: "unknown", fix: expect.stringContaining("read access") });
    const down = await readLifecycleProtection(GITHUB, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(down.detail).toContain("could not be reached");
    // One source that says nothing keeps an unprotected branch from reading as allowed.
    const half = await readLifecycleProtection(GITHUB, recorded({ [RULES]: { status: 200, body: [] }, [CLASSIC]: { status: 403 } }).fetch);
    expect(half).toMatchObject({ force: "unknown", deletion: "unknown" });
  });
});

describe("GitLab", () => {
  const LIST = "/projects/acme%2Fapi/protected_branches?per_page=100";
  test("a protected branch refuses a deletion, and a force push unless it allows one, matched by wildcard too", async () => {
    const protectedBranch = await readLifecycleProtection(GITLAB, recorded({ [LIST]: { status: 200, body: [{ name: "main", allow_force_push: false }, { name: "chant/*", allow_force_push: false }] } }).fetch);
    expect(protectedBranch).toMatchObject({ force: "refused", deletion: "refused" });
    const loose = await readLifecycleProtection(GITLAB, recorded({ [LIST]: { status: 200, body: [{ name: "chant/lifecycle", allow_force_push: true }] } }).fetch);
    expect(loose).toMatchObject({ force: "allowed", deletion: "refused" });
    const none = await readLifecycleProtection(GITLAB, recorded({ [LIST]: { status: 200, body: [{ name: "main", allow_force_push: false }] } }).fetch);
    expect(none).toMatchObject({ force: "allowed", deletion: "allowed" });
    expect((await readLifecycleProtection(GITLAB, recorded({ [LIST]: { status: 403 } }).fetch)).force).toBe("unknown");
  });

  test("sends the private token header", async () => {
    const { fetch, calls } = recorded({ [LIST]: { status: 200, body: [] } });
    await readLifecycleProtection(GITLAB, fetch);
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe("glpat_x");
  });
});

describe("Forgejo", () => {
  const LIST = "/repos/acme/api/branch_protections";
  test("a branch protection rule matched by its pattern refuses a deletion, and a force push unless it enables one", async () => {
    const rule = await readLifecycleProtection(FORGEJO, recorded({ [LIST]: { status: 200, body: [{ rule_name: "main" }, { rule_name: "chant/lifecycle" }] } }).fetch);
    expect(rule).toMatchObject({ force: "refused", deletion: "refused" });
    const forced = await readLifecycleProtection(FORGEJO, recorded({ [LIST]: { status: 200, body: [{ rule_name: "chant/**", enable_force_push: true }] } }).fetch);
    expect(forced).toMatchObject({ force: "allowed", deletion: "refused" });
    const none = await readLifecycleProtection(FORGEJO, recorded({ [LIST]: { status: 200, body: [{ rule_name: "main" }] } }).fetch);
    expect(none).toMatchObject({ force: "allowed", deletion: "allowed" });
    expect((await readLifecycleProtection(FORGEJO, recorded({ [LIST]: { status: 401 } }).fetch)).deletion).toBe("unknown");
  });
});

describe("the doctor check", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const checkout = (url: string) => {
    const dir = mkdtempSync(join(tmpdir(), "chant-lifecycle-protection-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
    return dir;
  };
  const ask = (dir: string, env: NodeJS.ProcessEnv, groups: string[], answer: Awaited<ReturnType<typeof readLifecycleProtection>>) =>
    releaseDoctor({ cwd: dir, publish: [], env, releaseWorkflow: null, groups: new Set(groups) as never, deps: { lifecycleProtection: async () => answer } });

  test("under verified-releases a forge that allows a force push is a warning that says how to protect the branch", async () => {
    const dir = checkout("https://github.com/acme/api.git");
    const report = await ask(dir, { GH_TOKEN: "t" }, ["verified-releases"], { force: "allowed", deletion: "refused", detail: "read from branch protection" });
    const target = report.targets.find((t) => t.kind === "lifecycle")!;
    expect(target.checks).toEqual([expect.objectContaining({ check: "lifecycle-protected", status: "warn", fix: expect.stringContaining("Protect chant/lifecycle") })]);
    expect(target.name).toBe("chant/lifecycle on github acme/api");
    const ok = await ask(dir, { GH_TOKEN: "t" }, ["who-ran-it"], { force: "refused", deletion: "refused", detail: "read from rulesets" });
    expect(ok.targets.find((t) => t.kind === "lifecycle")!.checks[0]).toMatchObject({ status: "ok" });
  });

  test("with no token it says unknown, and without either group, or without a forge, it asks nothing", async () => {
    const dir = checkout("https://github.com/acme/api.git");
    const noToken = await ask(dir, {}, ["verified-releases"], { force: "refused", deletion: "refused", detail: "" });
    expect(noToken.targets.find((t) => t.kind === "lifecycle")!.checks[0]).toMatchObject({ status: "unknown", message: expect.stringContaining("no token") });
    expect((await ask(dir, { GH_TOKEN: "t" }, ["supply-chain"], { force: "allowed", deletion: "allowed", detail: "" })).targets.some((t) => t.kind === "lifecycle")).toBe(false);
    const elsewhere = checkout("ssh://git@git.internal.example/acme/api.git");
    expect((await ask(elsewhere, { GH_TOKEN: "t" }, ["verified-releases"], { force: "allowed", deletion: "allowed", detail: "" })).targets.some((t) => t.kind === "lifecycle")).toBe(false);
  });
});
