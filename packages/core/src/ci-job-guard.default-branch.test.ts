/**
 * #5032: a waves job that runs from the repository's default branch, by
 * the name the forge gives it at run time, with or without named branches
 * beside it. The default branch here is `trunk`, never `main`.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { CHANT_EXIT } from "./exit-codes";
import {
  checkJob,
  describeJobGuard,
  JOB_DEFAULT_BRANCH_ENV,
  JOB_GUARD_DEFAULT_BRANCH_JS,
  JOB_GUARD_ENV,
  JOB_GUARD_JS,
  jobGuardLine,
  jobGuardSpec,
  jobSeen,
  parseJobGuardSpec,
  type JobGuardSpec,
} from "./ci-job-guard";
import { opWaveDefaultBranch, tipAppliesTargets } from "./op/op-waves-stand-down";
import { githubWavesBranchIf, gitlabWavesBranches, wavesNamedBranches } from "./ci-jobs";
import type { OpWavesSpec } from "./op/op-waves";

const noFetch = (() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch;
const program = (spec: JobGuardSpec, env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", JOB_GUARD_DEFAULT_BRANCH_JS], { env: { PATH: process.env.PATH ?? "", [JOB_GUARD_ENV]: JSON.stringify(spec), ...env }, encoding: "utf-8" });

describe("the guard on the default branch (#5032)", () => {
  test("the spec says so only when asked, and parses back", () => {
    expect(jobGuardSpec({ forge: "github", job: "w", branches: [] , defaultBranch: true })).toEqual({ forge: "github", job: "w", branches: [], defaultBranch: true });
    expect(jobGuardSpec({ forge: "github", job: "w", branches: ["main"] })).not.toHaveProperty("defaultBranch");
    expect(parseJobGuardSpec(JSON.stringify({ forge: "gitlab", job: "w", branches: [], defaultBranch: true })).defaultBranch).toBe(true);
    expect(() => parseJobGuardSpec(JSON.stringify({ forge: "gitlab", job: "w", branches: [], defaultBranch: "main" }))).toThrow(/defaultBranch is true or absent/);
  });

  const github: JobGuardSpec = { forge: "github", job: "wave 1 (wave-1) of tf-apply", product: "terragucci", branches: [], defaultBranch: true };
  const forgejo: JobGuardSpec = { ...github, forge: "forgejo", branches: ["release"] };
  const gitlab: JobGuardSpec = { forge: "gitlab", job: "wave 1 (wave-1) of tf-apply", branches: ["release"], defaultBranch: true };

  test("GitHub admits the default branch the event names, and refuses main when it is not that", async () => {
    const at = (ref: string, def?: string) => ({ GITHUB_REF: ref, ...(def !== undefined ? { [JOB_DEFAULT_BRANCH_ENV]: def } : {}) });
    expect(checkJob(github, await jobSeen(github, at("refs/heads/trunk", "trunk"), noFetch)).problems).toEqual([]);
    expect(checkJob(github, await jobSeen(github, at("refs/heads/main", "trunk"), noFetch)).problems).toEqual(["ref: expected refs/heads/trunk, found refs/heads/main"]);
    expect(checkJob(github, await jobSeen(github, at("refs/heads/trunk"), noFetch)).problems).toEqual([`ref: the job runs from the default branch, and the forge names none (no ${JOB_DEFAULT_BRANCH_ENV})`]);
  });

  test("Forgejo admits the default branch and the named one beside it", async () => {
    const seen = (ref: string) => jobSeen(forgejo, { GITHUB_REF: ref, [JOB_DEFAULT_BRANCH_ENV]: "trunk" }, noFetch);
    expect(checkJob(forgejo, await seen("refs/heads/trunk")).checked).toContain("ref refs/heads/trunk");
    expect(checkJob(forgejo, await seen("refs/heads/release")).checked).toContain("ref refs/heads/release");
    expect(checkJob(forgejo, await seen("refs/heads/dev")).problems).toEqual(["ref: expected refs/heads/trunk or refs/heads/release, found refs/heads/dev"]);
  });

  test("GitLab reads CI_DEFAULT_BRANCH, and still asks for a protected ref", async () => {
    const env = (ref: string, prot = "true") => ({ CI_COMMIT_REF_NAME: ref, CI_COMMIT_REF_PROTECTED: prot, CI_DEFAULT_BRANCH: "trunk" });
    expect(checkJob(gitlab, await jobSeen(gitlab, env("trunk"), noFetch)).problems).toEqual([]);
    expect(checkJob(gitlab, await jobSeen(gitlab, env("release"), noFetch)).problems).toEqual([]);
    expect(checkJob(gitlab, await jobSeen(gitlab, env("main"), noFetch)).problems).toEqual(["ref: expected trunk or release, found main"]);
    expect(checkJob(gitlab, await jobSeen(gitlab, env("trunk", "false"), noFetch)).problems).toEqual(["ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false"]);
  });

  test("a spec without defaultBranch reads no default branch", async () => {
    const plain: JobGuardSpec = { forge: "gitlab", job: "w", branches: ["main"] };
    expect(await jobSeen(plain, { CI_COMMIT_REF_NAME: "trunk", CI_DEFAULT_BRANCH: "trunk" }, noFetch)).not.toHaveProperty("defaultBranch");
    expect(checkJob(plain, await jobSeen(plain, { CI_COMMIT_REF_NAME: "trunk", CI_COMMIT_REF_PROTECTED: "true", CI_DEFAULT_BRANCH: "trunk" }, noFetch)).problems).toEqual(["ref: expected main, found trunk"]);
  });

  const cases: Array<[string, JobGuardSpec, Record<string, string>]> = [
    ["GitHub on the default branch", github, { GITHUB_REF: "refs/heads/trunk", [JOB_DEFAULT_BRANCH_ENV]: "trunk" }],
    ["GitHub on main, which is not it", github, { GITHUB_REF: "refs/heads/main", [JOB_DEFAULT_BRANCH_ENV]: "trunk" }],
    ["GitHub with no default branch named", github, { GITHUB_REF: "refs/heads/trunk" }],
    ["Forgejo on the named branch", forgejo, { GITHUB_REF: "refs/heads/release", [JOB_DEFAULT_BRANCH_ENV]: "trunk" }],
    ["Forgejo elsewhere", forgejo, { GITHUB_REF: "refs/heads/dev", [JOB_DEFAULT_BRANCH_ENV]: "trunk" }],
    ["GitLab on the default branch", gitlab, { CI_COMMIT_REF_NAME: "trunk", CI_COMMIT_REF_PROTECTED: "true", CI_DEFAULT_BRANCH: "trunk" }],
    ["GitLab on main, which is not it", gitlab, { CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_DEFAULT_BRANCH: "trunk" }],
    ["GitLab with only the named branch to go by", { ...gitlab }, { CI_COMMIT_REF_NAME: "release", CI_COMMIT_REF_PROTECTED: "true" }],
  ];
  for (const [name, spec, env] of cases) {
    test(`the node -e program agrees with checkJob: ${name}`, async () => {
      const r = program(spec, env);
      const want = describeJobGuard(spec, checkJob(spec, await jobSeen(spec, env, noFetch)));
      expect(r.status).toBe(want.ok ? 0 : CHANT_EXIT.misplaced);
      expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(want.out);
      expect(r.stderr.trim().split("\n").filter(Boolean)).toEqual(want.err);
    });
  }

  test("the program holds no single quote, and a job without defaultBranch keeps the program it had", () => {
    expect(JOB_GUARD_DEFAULT_BRANCH_JS).not.toContain("'");
    expect(JOB_GUARD_JS).not.toContain(JOB_DEFAULT_BRANCH_ENV);
    expect(jobGuardLine()).toBe(`(cd / && node -e '${JOB_GUARD_JS}')`);
    expect(jobGuardLine({})).toBe(jobGuardLine());
    expect(jobGuardLine({ defaultBranch: true })).toBe(`(cd / && node -e '${JOB_GUARD_DEFAULT_BRANCH_JS}')`);
  });
});

describe("the branches a waves spec runs from (#5032)", () => {
  test("named alone, or beside the default branch", () => {
    expect(wavesNamedBranches({})).toEqual(["main"]);
    expect(wavesNamedBranches({ defaultBranch: true })).toEqual([]);
    expect(wavesNamedBranches({ defaultBranch: true, branches: ["release"] })).toEqual(["release"]);
    expect(githubWavesBranchIf({ defaultBranch: true, branches: ["release"] })).toBe("github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/release'");
    expect(gitlabWavesBranches({ defaultBranch: true, branches: ["release"] }).map((b) => b.operand)).toEqual(["$CI_DEFAULT_BRANCH", '"release"']);
    expect(gitlabWavesBranches({ branches: ["main"] }).map((b) => b.operand)).toEqual(['"main"']);
  });
});

describe("the stand-down on the default branch (#5032)", () => {
  const atTip = { name: "tf-apply", op: "tf-apply", defaultBranch: true, waves: [{ name: "wave-1", runs: [{ target: "network" }] }] } as unknown as OpWavesSpec;
  test("a newer commit on the default branch, by its run-time name, makes the wave stand down", () => {
    expect(tipAppliesTargets(atTip, "trunk", "wave-1", ["network"], "trunk")).toBe(true);
    expect(tipAppliesTargets(atTip, "main", "wave-1", ["network"], "trunk")).toBe(false);
    expect(tipAppliesTargets(atTip, "trunk", "wave-1", ["network"])).toBe(false);
    expect(tipAppliesTargets({ ...atTip, branches: ["release"] }, "release", "wave-1", ["network"], "trunk")).toBe(true);
    // Without defaultBranch the spec runs on main, as before.
    expect(tipAppliesTargets({ ...atTip, defaultBranch: undefined } as unknown as OpWavesSpec, "main", "wave-1", ["network"], "trunk")).toBe(true);
  });
  test("the job's environment names it: CHANT_DEFAULT_BRANCH, else GitLab's CI_DEFAULT_BRANCH", () => {
    expect(opWaveDefaultBranch({ CHANT_DEFAULT_BRANCH: "trunk" })).toBe("trunk");
    expect(opWaveDefaultBranch({ CI_DEFAULT_BRANCH: "trunk" })).toBe("trunk");
    expect(opWaveDefaultBranch({ CHANT_DEFAULT_BRANCH: " " })).toBeUndefined();
  });
});
