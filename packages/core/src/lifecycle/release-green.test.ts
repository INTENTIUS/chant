/**
 * Release-only adoption (#5149): an artifact release, cut with no
 * environments from what `release.publish` declares, and the pluggable green
 * gate (`release.green`): a chant green tag, the forge's checks, or none,
 * which the security groups refuse. The gate passed is recorded on the cut
 * line, shown by `release verify` and carried in the provenance statement,
 * and an artifact release is published under the same signature checks as
 * any other.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease, planRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import { checkState, forgeChecksReader, judgeChecks, resolveGreenSource, type ForgeChecksReader } from "./release-green";
import { readCuts, readRelease, type ReleasePublish } from "./release-store";
import { preparePublish, type PublishPlan, type PublishRefusal } from "./release-publish";
import { verifyRelease } from "./release-verify";
import { releaseProvenance } from "./publish-attachments";
import type { TargetCompiler } from "../components/release-compile";
import type { ForgeFetch, ForgeTarget } from "../pr-forge";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

/** A compiler that must not be asked: an artifact release compiles nothing. */
const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};

const NPM: ReleasePublish = { target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" };
const AT = "2026-11-15T10:00:00.000Z";

/** A project with only a package.json and a chant.config.ts holding release.publish, and a workspace declaration when given. */
function project(declaration: Record<string, unknown> | null = null): { r: TestRepo; head: string } {
  const r = new TestRepo("release-only");
  repos.push(r);
  if (declaration) r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [], ...declaration }, null, 2));
  r.write("package.json", JSON.stringify({ name: "acme-cli", version: "0.0.0" }, null, 2));
  r.write("chant.config.ts", `export default { release: { publish: [{ type: "npm", packages: ["."] }] } };\n`);
  const head = r.commit("init");
  return { r, head };
}

const request = (r: TestRepo, extra: Partial<CutRequest> = {}): CutRequest => ({
  cwd: r.dir,
  compiler: noCompile,
  label: "1.0.0",
  actor: "alice",
  env: {},
  now: () => new Date(AT),
  publishes: [NPM],
  ...extra,
});

const passing: ForgeChecksReader = async () => ({ green: true, forge: "github", checks: ["build", "test"] });
const refusal = async (p: Promise<unknown>): Promise<ReleaseCutError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
};

describe("the green gate's default", () => {
  test("is chant with ci.green or ci/green tags, else forge-checks, and release.green wins", () => {
    expect(resolveGreenSource(undefined, true)).toBe("chant");
    expect(resolveGreenSource(undefined, false, true)).toBe("chant");
    expect(resolveGreenSource(undefined, false)).toBe("forge-checks");
    expect(resolveGreenSource("none", true)).toBe("none");
  });
});

describe("an artifact release (no environments)", () => {
  test("is cut from release.publish alone, compiles nothing, and records its targets and the forge checks it passed", async () => {
    const { r, head } = project();
    const plan = await planRelease(request(r, { forgeChecks: passing }));
    expect(plan.targets).toEqual([]);
    expect(plan.publishes).toEqual([NPM]);
    const result = await cutRelease(request(r, { forgeChecks: passing }));
    expect(result.release.targets).toEqual([]);
    expect(result.release.publishes).toEqual([NPM]);
    expect(result.release.commit).toBe(head);
    expect(result.release.releaseDigest).toBe(plan.releaseDigest);
    expect(await readRelease(result.release.releaseDigest, { cwd: r.dir })).toEqual(result.release);
    expect(result.cut?.green).toEqual({ source: "forge-checks", forge: "github", checks: ["build", "test"] });
  });

  test("runs its build once the gate has passed, and a build that fails cuts nothing", async () => {
    const { r } = project();
    const ran: string[] = [];
    await cutRelease(request(r, { forgeChecks: passing, build: () => void ran.push("build") }));
    expect(ran).toEqual(["build"]);
    const { r: r2 } = project();
    await expect(
      cutRelease(request(r2, { forgeChecks: passing, build: () => { throw new Error("build failed"); } })),
    ).rejects.toThrow("build failed");
    expect((await readCuts({ cwd: r2.dir })).cuts).toEqual([]);
  });

  test("with no environments and no publish target there is nothing to release", async () => {
    const { r } = project();
    const err = await refusal(cutRelease(request(r, { forgeChecks: passing, publishes: [] })));
    expect(err.code).toBe("release-no-environments");
    expect(err.fix).toContain("release.publish");
  });
});

describe("release.green: forge-checks", () => {
  test("refuses a commit whose checks did not pass, naming them, and an override is the way past it", async () => {
    const { r } = project();
    const failing: ForgeChecksReader = async () => judgeChecks("github", [{ name: "test", state: "failure", status: "failure" }], []);
    const err = await refusal(cutRelease(request(r, { forgeChecks: failing })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toContain("a check did not pass on github: test (failure)");
  });

  test("refuses with release-forge-checks-unavailable when no forge can be asked", async () => {
    const { r } = project();
    const err = await refusal(cutRelease(request(r)));
    expect(err.code).toBe("release-forge-checks-unavailable");
    expect(err.message).toContain("the origin remote names no forge");
  });

  test("a lane is a ci.green lane, which forge-checks does not read", async () => {
    const { r } = project();
    const err = await refusal(cutRelease(request(r, { forgeChecks: passing, lane: "fast" })));
    expect(err.code).toBe("declaration-invalid");
  });
});

describe("release.green: none", () => {
  test("cuts with no gate, and the cut line says so", async () => {
    const { r } = project();
    const result = await cutRelease(request(r, { green: "none" }));
    expect(result.cut?.green).toEqual({ source: "none" });
  });

  test.each([["supply-chain"], ["verified-releases"]])("is refused under the %s security group", async (group) => {
    const { r } = project({ security: [group] });
    const err = await refusal(cutRelease(request(r, { green: "none" })));
    expect(err.code).toBe("release-green-none-refused");
    expect(err.message).toContain(`the ${group} security group`);
    expect((await readCuts({ cwd: r.dir })).cuts).toEqual([]);
  });

  test("is refused under a release gate in identity.gates", async () => {
    const { r } = project({ identity: { gates: { release: {} } } });
    const err = await refusal(cutRelease(request(r, { green: "none", sign: true })));
    expect(err.code).toBe("release-green-none-refused");
    expect(err.message).toContain("the release gate in identity.gates");
  });
});

describe("the gate a cut passed, after the cut", () => {
  test("release verify shows it for each cut", async () => {
    const { r } = project();
    await cutRelease(request(r, { forgeChecks: passing }));
    const v = await verifyRelease({ cwd: r.dir, ref: "1.0.0" });
    if ("error" in v) throw new Error(v.error.message);
    expect(v.cuts.map((c) => c.green)).toEqual([{ source: "forge-checks", forge: "github", checks: ["build", "test"] }]);
  });

  test("the publish's provenance statement carries it, and leaves it out for a cut that recorded none", async () => {
    const { r } = project();
    await cutRelease(request(r, { green: "none" }));
    const plan = (await preparePublish({ cwd: r.dir, ref: "1.0.0", env: { PATH: process.env.PATH } })) as PublishPlan;
    expect("refusal" in plan).toBe(false);
    expect(plan.cut?.green).toEqual({ source: "none" });
    const ctx = { release: plan.release, label: plan.label, cut: plan.cut, provenance: plan.provenance, cwd: r.dir } as Parameters<typeof releaseProvenance>[0];
    const statement = JSON.parse(Buffer.from(releaseProvenance(ctx, []).bytes).toString("utf-8"));
    expect(statement.predicate.cut.green).toEqual({ source: "none" });
    const older = JSON.parse(Buffer.from(releaseProvenance({ ...ctx, cut: { ...plan.cut!, green: undefined } }, []).bytes).toString("utf-8"));
    expect("green" in older.predicate.cut).toBe(false);
  });

  test("an artifact release is published under the same signature checks: verified-releases refuses it unsigned", async () => {
    const { r } = project({ security: ["verified-releases"] });
    await cutRelease(request(r, { forgeChecks: passing }));
    const got = (await preparePublish({ cwd: r.dir, ref: "1.0.0", env: { PATH: process.env.PATH } })) as { refusal: PublishRefusal };
    expect(got.refusal.code).toBe("release-unsigned");
  });
});

describe("reading a forge's checks", () => {
  test("a check's state from status and conclusion", () => {
    expect(checkState("completed", "success")).toBe("success");
    expect(checkState("completed", "skipped")).toBe("success");
    expect(checkState("completed", "timed_out")).toBe("failure");
    expect(checkState("in_progress")).toBe("pending");
    expect(checkState("running")).toBe("pending");
    expect(checkState("failed")).toBe("failure");
  });

  test("no check, an unfinished one, or a required one missing is not green", () => {
    expect(judgeChecks("github", [], []).green).toBe(false);
    expect(judgeChecks("github", [{ name: "a", state: "pending", status: "queued" }], [])).toMatchObject({ green: false, why: expect.stringContaining("not finished") });
    expect(judgeChecks("github", [{ name: "a", state: "success", status: "success" }], ["b"])).toMatchObject({ green: false, why: expect.stringContaining("requires b") });
    expect(judgeChecks("github", [{ name: "a", state: "success", status: "success" }], ["a"])).toEqual({ green: true, forge: "github", checks: ["a"] });
  });

  /** A fetch that answers each path from `routes`, recording what was asked. */
  function fakeFetch(routes: Record<string, unknown>): ForgeFetch & { asked: string[] } {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      const hit = Object.entries(routes).find(([p]) => url.includes(p));
      if (!hit) return { ok: false, status: 404, text: async () => "{}" };
      return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
    }) as unknown as ForgeFetch & { asked: string[] };
    f.asked = asked;
    return f;
  }
  const target = (kind: ForgeTarget["kind"], apiBase: string, repo = "acme/cli"): ForgeTarget => ({ kind, apiBase, repo, host: "h", token: "t", tokenSource: "GH_TOKEN" });

  test("GitHub: check runs and statuses, the branch rules' required checks, and the release run's own jobs left out", async () => {
    const f = fakeFetch({
      "/check-runs": {
        check_runs: [
          { name: "test", status: "completed", conclusion: "success", details_url: "https://github.com/acme/cli/actions/runs/1/job/2" },
          { name: "cut", status: "in_progress", conclusion: null, details_url: "https://github.com/acme/cli/actions/runs/99/job/3" },
          { name: "cut", status: "completed", conclusion: "failure", details_url: "https://github.com/acme/cli/actions/runs/98/job/1" },
        ],
      },
      "/status": { statuses: [{ context: "ci/lint", state: "success" }] },
      "/actions/runs?head_sha=abc": { workflow_runs: [{ id: 98, path: ".github/workflows/publish.yml" }, { id: 1, path: ".github/workflows/ci.yml" }] },
      "/rules/branches/main": [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }],
    });
    const read = forgeChecksReader(target("github", "https://api.github.com"), { GITHUB_RUN_ID: "99", GITHUB_WORKFLOW_REF: "acme/cli/.github/workflows/publish.yml@refs/heads/main" }, f);
    expect(await read("abc", "main")).toEqual({ green: true, forge: "github", checks: ["ci/lint", "test"] });
    const missing = forgeChecksReader(
      target("github", "https://api.github.com"),
      {},
      fakeFetch({ "/check-runs": { check_runs: [] }, "/status": { statuses: [{ context: "x", state: "success" }] }, "/rules/branches/main": [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }] }),
    );
    expect(await missing("abc", "main")).toMatchObject({ green: false, why: "the branch requires test, which github does not report on it" });
  });

  test("Forgejo: commit statuses; GitLab: the newest pipeline of each source, the release pipeline left out", async () => {
    const fj = forgeChecksReader(target("forgejo", "https://code.example/api/v1"), {}, fakeFetch({ "/status": { statuses: [{ context: "ci / test", status: "failure" }] } }));
    expect(await fj("abc", null)).toMatchObject({ green: false, forge: "forgejo", why: "a check did not pass on forgejo: ci / test (failure)" });
    const gl = forgeChecksReader(
      target("gitlab", "https://gitlab.example/api/v4", "acme/cli"),
      { CI_PIPELINE_ID: "7" },
      fakeFetch({
        "/pipelines?sha=abc": [
          { id: 7, status: "running", source: "web" },
          { id: 6, status: "success", source: "push" },
          { id: 5, status: "failed", source: "push" },
        ],
      }),
    );
    expect(await gl("abc", null)).toEqual({ green: true, forge: "gitlab", checks: ["pipeline (push)"] });
  });
});
