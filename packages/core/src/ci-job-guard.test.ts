/**
 * The apply-job guard (#4624): the expectation a generator writes, each
 * refusal on the three forges, and the `node -e` program giving the same
 * answers as checkJob. Written for the ci-products post-merge pass.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { checkJob, describeJobGuard, JOB_GUARD_ENV, JOB_GUARD_JS, jobGuardSpec, jobSeen, opWaveJobLabel, parseJobGuardSpec, type JobGuardSpec } from "./ci-job-guard";
import { CHANT_EXIT } from "./exit-codes";

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("jobGuardSpec", () => {
  test("GitHub reads the environment only in a job that may request a token", () => {
    expect(jobGuardSpec({ forge: "github", job: "j", environment: "prod", branches: ["main"] }).forgeEnvironment).toBeUndefined();
    expect(jobGuardSpec({ forge: "github", job: "j", environment: "prod", branches: ["main"], idToken: true }).forgeEnvironment).toBe("prod");
  });

  test("GitLab always reads it, and the runner's labels are its tags", () => {
    const s = jobGuardSpec({ forge: "gitlab", job: "j", environment: "prod", branches: ["main"], runner: ["deploy", "eu"] });
    expect(s).toMatchObject({ forgeEnvironment: "prod", runnerTags: ["deploy", "eu"] });
  });

  test("Forgejo never reads an environment, and a self-hosted label asks for a self-hosted runner", () => {
    const s = jobGuardSpec({ forge: "forgejo", job: "j", environment: "prod", branches: ["main"], runner: ["self-hosted", "linux"], idToken: true });
    expect(s.forgeEnvironment).toBeUndefined();
    expect(s.selfHosted).toBe(true);
  });

  test("chant's own product is left out, another is kept", () => {
    expect(jobGuardSpec({ forge: "github", job: "j", product: "chant", branches: ["main"] }).product).toBeUndefined();
    expect(jobGuardSpec({ forge: "github", job: "j", product: "plywood", branches: ["main"] }).product).toBe("plywood");
  });
});

describe("checkJob refusals", () => {
  const gh: JobGuardSpec = { forge: "github", job: "wave 1 (prod) of deploy", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };
  const gl: JobGuardSpec = { forge: "gitlab", job: "wave 1 (prod) of deploy", forgeEnvironment: "prod", branches: ["main"], runnerTags: ["deploy"] };
  const fj: JobGuardSpec = { forge: "forgejo", job: "wave 1 (prod) of deploy", branches: ["main"], selfHosted: true };

  test("GitHub: all match", () => {
    const r = checkJob(gh, { ref: "refs/heads/main", forgeEnvironment: "prod", runnerEnvironment: "self-hosted" });
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["forge environment prod", "ref refs/heads/main", "self-hosted runner"]);
  });

  test("GitHub: another environment, another ref, a hosted runner", () => {
    const r = checkJob(gh, { ref: "refs/heads/feature", forgeEnvironment: "staging", runnerEnvironment: "github-hosted" });
    expect(r.problems).toEqual([
      "forge environment: expected prod, found staging",
      "ref: expected refs/heads/main, found refs/heads/feature",
      "runner: expected self-hosted, found github-hosted",
    ]);
  });

  test("GitHub: no environment, and one that could not be read", () => {
    expect(checkJob(gh, { ref: "refs/heads/main", forgeEnvironment: null }).problems).toEqual(["forge environment: expected prod, found none"]);
    expect(checkJob(gh, { ref: "refs/heads/main", forgeEnvironmentError: "no token" }).problems[0]).toBe("forge environment: expected prod, and it could not be read: no token");
  });

  test("GitLab: another environment, an unprotected ref, a missing tag", () => {
    const r = checkJob(gl, { ref: "main", refProtected: "false", forgeEnvironment: "dev", runnerTags: ["shared"] });
    expect(r.problems).toEqual([
      "forge environment: expected prod, found dev",
      "ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false",
      "runner: expected tags deploy, found shared",
    ]);
    expect(checkJob(gl, { ref: "feature", refProtected: "true", forgeEnvironment: "prod" }).problems).toEqual([
      "ref: expected main, found feature",
      "runner: expected tags deploy, and the job has no CI_RUNNER_TAGS",
    ]);
  });

  test("Forgejo: ref and runner only", () => {
    const r = checkJob(fj, { ref: "refs/heads/dev", runnerEnvironment: "github-hosted" });
    expect(r.skipped).toContain("forge environment (Forgejo has none)");
    expect(r.problems).toEqual(["ref: expected refs/heads/main, found refs/heads/dev", "runner: expected self-hosted, found github-hosted"]);
    expect(checkJob(fj, { ref: "refs/heads/main" }).skipped).toContain("runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)");
  });

  test("the refusal names the product and the job, with the reason", () => {
    const spec = { ...gh, product: "plywood" };
    const d = describeJobGuard(spec, checkJob(spec, { ref: "refs/heads/x", forgeEnvironment: "prod", runnerEnvironment: "self-hosted" }));
    expect(d.ok).toBe(false);
    expect(d.err[0]).toBe("plywood check-job: wave 1 (prod) of deploy: ref: expected refs/heads/main, found refs/heads/x");
    expect(d.err.at(-1)).toContain("stops before any credential is taken or code checked out");
  });
});

describe("jobSeen", () => {
  test("GitHub reads the environment and runner from a token for the guard's own audience", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ value: jwt({ environment: "prod", runner_environment: "self-hosted" }) }) };
    }) as unknown as typeof fetch;
    const seen = await jobSeen({ forge: "github", job: "j", forgeEnvironment: "prod", branches: ["main"] }, { GITHUB_REF: "refs/heads/main", ACTIONS_ID_TOKEN_REQUEST_URL: "https://t?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "b" }, fetchFn);
    expect(seen).toEqual({ ref: "refs/heads/main", forgeEnvironment: "prod", runnerEnvironment: "self-hosted" });
    expect(calls[0]).toBe("https://t?x=1&audience=chant-check-job");
  });

  test("GitLab reads its variables", async () => {
    const seen = await jobSeen({ forge: "gitlab", job: "j", branches: ["main"] }, { CI_ENVIRONMENT_NAME: "prod", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["a","b"]' });
    expect(seen).toEqual({ forgeEnvironment: "prod", ref: "main", refProtected: "true", runnerTags: ["a", "b"] });
  });
});

describe("parseJobGuardSpec", () => {
  test("refuses a missing or broken variable", () => {
    expect(() => parseJobGuardSpec(undefined)).toThrow(`${JOB_GUARD_ENV} is not set`);
    expect(() => parseJobGuardSpec("{")).toThrow("is not JSON");
    expect(() => parseJobGuardSpec('{"forge":"svn","job":"j","branches":[]}')).toThrow("forge");
  });
});

test("opWaveJobLabel", () => {
  expect(opWaveJobLabel("deploy", { kind: "wave", wave: 2, waveName: "prod" })).toBe("wave 2 (prod) of deploy");
  expect(opWaveJobLabel("deploy", { kind: "decide", wave: 2, waveName: "prod" })).toBe("the deciding job of wave 2 (prod) of deploy");
  expect(opWaveJobLabel("deploy", { kind: "share", wave: 2, waveName: "prod", share: 1, group: "eu" })).toBe("share 1 of job group eu of wave 2 (prod) of deploy");
});

describe("the node -e program agrees with checkJob", () => {
  const run = (spec: JobGuardSpec, env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "", [JOB_GUARD_ENV]: JSON.stringify(spec), ...env }, encoding: "utf-8" });

  const cases: Array<[string, JobGuardSpec, Record<string, string>]> = [
    ["GitLab match", { forge: "gitlab", job: "w", forgeEnvironment: "prod", branches: ["main"], runnerTags: ["d"] }, { CI_ENVIRONMENT_NAME: "prod", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: "d,e" }],
    ["GitLab refusal", { forge: "gitlab", job: "w", forgeEnvironment: "prod", branches: ["main"], runnerTags: ["d"] }, { CI_ENVIRONMENT_NAME: "dev", CI_COMMIT_REF_NAME: "x", CI_COMMIT_REF_PROTECTED: "false" }],
    ["Forgejo match", { forge: "forgejo", job: "w", branches: ["main"], selfHosted: true }, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" }],
    ["Forgejo refusal", { forge: "forgejo", job: "w", product: "plywood", branches: ["main", "release"], selfHosted: true }, { GITHUB_REF: "refs/heads/dev" }],
    ["GitHub without a token to ask for", { forge: "github", job: "w", forgeEnvironment: "prod", branches: ["main"] }, { GITHUB_REF: "refs/heads/main" }],
  ];

  for (const [name, spec, env] of cases) {
    test(name, async () => {
      const r = run(spec, env);
      const want = describeJobGuard(spec, checkJob(spec, await jobSeen(spec, env, (() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch)));
      expect(r.status).toBe(want.ok ? 0 : CHANT_EXIT.misplaced);
      expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(want.out);
      expect(r.stderr.trim().split("\n").filter(Boolean)).toEqual(want.err);
    });
  }

  test("a missing variable stops the job", () => {
    const r = spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf-8" });
    expect(r.status).toBe(CHANT_EXIT.misplaced);
    expect(r.stderr).toContain(`${JOB_GUARD_ENV} is not JSON`);
  });

  test("the program holds no single quote, so the shell line keeps it whole", () => {
    expect(JOB_GUARD_JS).not.toContain("'");
  });
});
