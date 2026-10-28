/**
 * `chant ci check-job` (#4624): one test per refusal, on each forge, from
 * the expectation in CHANT_JOB_GUARD. The forge's variables and its token
 * endpoint are fakes. Written for the ci-products post-merge pass.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../registry";
import { runCiCheckJob } from "./ci-check-job";
import { JOB_GUARD_ENV, type JobGuardSpec } from "../../ci-job-guard";

const ctx = { args: {}, plugins: [], serializers: [] } as unknown as CommandContext;
const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const tokenFetch = (claims: Record<string, unknown>) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ value: jwt(claims) }) })) as unknown as typeof fetch;
const noFetch = (async () => {
  throw new Error("no fetch");
}) as unknown as typeof fetch;

let errors: string[];
let logs: string[];
beforeEach(() => {
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
  vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

const withSpec = (spec: JobGuardSpec, env: Record<string, string>) => ({ [JOB_GUARD_ENV]: JSON.stringify(spec), ...env });
const gh: JobGuardSpec = { forge: "github", job: "wave 1 (prod) of deploy", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };
const tokenEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://t?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "b" };

describe("chant ci check-job on GitHub", () => {
  test("passes where the spec set the job to run", async () => {
    const code = await runCiCheckJob(ctx, withSpec(gh, { GITHUB_REF: "refs/heads/main", ...tokenEnv }), tokenFetch({ environment: "prod", runner_environment: "self-hosted" }));
    expect(code).toBe(0);
    expect(logs[0]).toBe("chant check-job: wave 1 (prod) of deploy: forge environment prod, ref refs/heads/main, self-hosted runner");
  });

  test("refuses another forge environment", async () => {
    const code = await runCiCheckJob(ctx, withSpec(gh, { GITHUB_REF: "refs/heads/main", ...tokenEnv }), tokenFetch({ environment: "staging", runner_environment: "self-hosted" }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("forge environment: expected prod, found staging");
  });

  test("refuses a job that cannot read its environment", async () => {
    const code = await runCiCheckJob(ctx, withSpec(gh, { GITHUB_REF: "refs/heads/main" }), noFetch);
    expect(code).toBe(1);
    expect(errors[0]).toContain("it needs permissions: id-token: write");
  });

  test("refuses another ref", async () => {
    const code = await runCiCheckJob(ctx, withSpec(gh, { GITHUB_REF: "refs/heads/feature", ...tokenEnv }), tokenFetch({ environment: "prod", runner_environment: "self-hosted" }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("ref: expected refs/heads/main, found refs/heads/feature");
  });

  test("refuses a hosted runner where the spec asks for a self-hosted one", async () => {
    const code = await runCiCheckJob(ctx, withSpec(gh, { GITHUB_REF: "refs/heads/main", ...tokenEnv }), tokenFetch({ environment: "prod", runner_environment: "github-hosted" }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("runner: expected self-hosted, found github-hosted");
  });
});

describe("chant ci check-job on GitLab", () => {
  const gl: JobGuardSpec = { forge: "gitlab", job: "wave 1 (prod) of deploy", product: "plywood", forgeEnvironment: "prod", branches: ["main"], runnerTags: ["deploy"] };
  const ok = { CI_ENVIRONMENT_NAME: "prod", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: "deploy" };

  test("passes", async () => {
    expect(await runCiCheckJob(ctx, withSpec(gl, ok), noFetch)).toBe(0);
    expect(logs[0]).toMatch(/^plywood check-job: /);
  });

  test("refuses another environment", async () => {
    expect(await runCiCheckJob(ctx, withSpec(gl, { ...ok, CI_ENVIRONMENT_NAME: "dev" }), noFetch)).toBe(1);
    expect(errors[0]).toBe("plywood check-job: wave 1 (prod) of deploy: forge environment: expected prod, found dev");
  });

  test("refuses another ref, and an unprotected one", async () => {
    expect(await runCiCheckJob(ctx, withSpec(gl, { ...ok, CI_COMMIT_REF_NAME: "feature", CI_COMMIT_REF_PROTECTED: "false" }), noFetch)).toBe(1);
    expect(errors).toContain("plywood check-job: wave 1 (prod) of deploy: ref: expected main, found feature");
    expect(errors).toContain("plywood check-job: wave 1 (prod) of deploy: ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false");
  });

  test("refuses a runner without the job's tags", async () => {
    expect(await runCiCheckJob(ctx, withSpec(gl, { ...ok, CI_RUNNER_TAGS: "shared" }), noFetch)).toBe(1);
    expect(errors[0]).toContain("runner: expected tags deploy, found shared");
  });
});

describe("chant ci check-job on Forgejo", () => {
  const fj: JobGuardSpec = { forge: "forgejo", job: "wave 1 (prod) of deploy", branches: ["main"], selfHosted: true };

  test("checks no environment", async () => {
    expect(await runCiCheckJob(ctx, withSpec(fj, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" }), noFetch)).toBe(0);
    expect(logs[0]).toContain("not checked: forge environment (Forgejo has none)");
  });

  test("refuses another ref", async () => {
    expect(await runCiCheckJob(ctx, withSpec(fj, { GITHUB_REF: "refs/heads/dev" }), noFetch)).toBe(1);
    expect(errors[0]).toContain("ref: expected refs/heads/main, found refs/heads/dev");
  });

  test("refuses a hosted runner", async () => {
    expect(await runCiCheckJob(ctx, withSpec(fj, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "github-hosted" }), noFetch)).toBe(1);
    expect(errors[0]).toContain("runner: expected self-hosted, found github-hosted");
  });
});

test("no expectation in the job stops it", async () => {
  expect(await runCiCheckJob(ctx, {}, noFetch)).toBe(1);
  expect(errors[0]).toContain(`${JOB_GUARD_ENV} is not set`);
});
