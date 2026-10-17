import { describe, test, expect } from "vitest";
import { ciCommitFromEnv, ciRunIdFromEnv, resolveGateRunLocator, runOriginOfLocator } from "./gate-run-locator";
import { resolveCiRun, resolveRunId } from "../lifecycle/release-ledger";

const GITHUB = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_RUN_ID: "9001",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SERVER_URL: "https://github.example",
  GITHUB_API_URL: "https://github.example/api/v3",
  GITHUB_SHA: "a".repeat(40),
};
const GITLAB = {
  GITLAB_CI: "true",
  CI_API_V4_URL: "https://gitlab.example/api/v4",
  CI_PROJECT_ID: "77",
  CI_PROJECT_PATH: "acme/app",
  CI_PIPELINE_ID: "5150",
  CI_PIPELINE_URL: "https://gitlab.example/acme/app/-/pipelines/5150",
  CI_JOB_ID: "31",
  CI_JOB_NAME: "deploy",
  CI_JOB_URL: "https://gitlab.example/acme/app/-/jobs/31",
  CI_COMMIT_SHA: "b".repeat(40),
};
const FORGEJO = {
  ...GITHUB,
  FORGEJO_ACTIONS: "true",
  GITHUB_WORKFLOW_REF: "acme/app/.forgejo/workflows/deploy.yml@refs/heads/main",
  GITHUB_REF_NAME: "main",
  GITHUB_SERVER_URL: "https://forgejo.example",
  GITHUB_API_URL: "https://forgejo.example/api/v1",
};

describe("runOriginOfLocator (#4020)", () => {
  test("a GitHub locator maps to forge github, with its repo and run page, and the run as the run id", () => {
    const locator = resolveGateRunLocator(GITHUB)!;
    expect(runOriginOfLocator(locator)).toEqual({
      runId: "9001",
      runOrigin: { forge: "github", repo: "acme/app", url: "https://github.example/acme/app/actions/runs/9001" },
    });
  });

  test("a Forgejo locator maps to forge github, since the url names the host", () => {
    const locator = resolveGateRunLocator(FORGEJO)!;
    expect(locator.forge).toBe("forgejo");
    expect(runOriginOfLocator(locator)).toEqual({
      runId: "9001",
      runOrigin: { forge: "github", repo: "acme/app", url: "https://forgejo.example/acme/app/actions/runs/9001" },
    });
  });

  test("a GitLab locator stays gitlab, with the project id as repo and the pipeline id as the run id", () => {
    const locator = resolveGateRunLocator(GITLAB)!;
    expect(runOriginOfLocator(locator)).toEqual({
      runId: "5150",
      runOrigin: { forge: "gitlab", repo: "77", url: "https://gitlab.example/acme/app/-/jobs/31" },
    });
  });

  test("the API base, attempt, job and workflow fields do not reach the origin", () => {
    const { runOrigin } = runOriginOfLocator(resolveGateRunLocator(GITHUB)!);
    expect(Object.keys(runOrigin).sort()).toEqual(["forge", "repo", "url"]);
  });

  test("a locator without a url maps to an origin without one", () => {
    const { api, repo, run } = resolveGateRunLocator(GITHUB)!;
    expect(runOriginOfLocator({ forge: "github", api, repo, run })).toEqual({ runId: "9001", runOrigin: { forge: "github", repo: "acme/app" } });
  });
});

describe("a GateRunLocator and the RunOrigin written for the same CI job name the same run (#4020)", () => {
  test.each([
    ["GitHub", GITHUB, "github"],
    ["Forgejo", FORGEJO, "github"],
    ["GitLab", GITLAB, "gitlab"],
  ] as const)("%s", (_name, env, forge) => {
    const locator = resolveGateRunLocator(env)!;
    const fromLocator = runOriginOfLocator(locator);
    const written = resolveCiRun(env);
    // A deploy record's run id is the one resolveRunId gives, and the gate's is the CI run id.
    expect(resolveRunId(undefined, env).runId).toBe(fromLocator.runId);
    expect(ciRunIdFromEnv(env)).toBe(fromLocator.runId);
    expect(written?.runId).toBe(fromLocator.runId);
    expect(written?.runOrigin.forge).toBe(forge);
    expect(fromLocator.runOrigin.forge).toBe(written?.runOrigin.forge);
  });

  test("on GitHub and Forgejo the two origins are the same object, repo and url included", () => {
    for (const env of [GITHUB, FORGEJO]) {
      expect(runOriginOfLocator(resolveGateRunLocator(env)!).runOrigin).toEqual(resolveCiRun(env)!.runOrigin);
    }
  });

  test("on GitLab the locator keeps the project id and the job page where the origin keeps the path and the pipeline page", () => {
    expect(runOriginOfLocator(resolveGateRunLocator(GITLAB)!).runOrigin).toEqual({ forge: "gitlab", repo: "77", url: GITLAB.CI_JOB_URL });
    expect(resolveCiRun(GITLAB)!.runOrigin).toEqual({ forge: "gitlab", repo: "acme/app", url: GITLAB.CI_PIPELINE_URL });
  });
});

describe("the CI environment helpers", () => {
  test("the commit is GITHUB_SHA or CI_COMMIT_SHA, and none outside CI", () => {
    expect(ciCommitFromEnv(GITHUB)).toBe("a".repeat(40));
    expect(ciCommitFromEnv(GITLAB)).toBe("b".repeat(40));
    expect(ciCommitFromEnv({})).toBeUndefined();
  });
  test("the run id is none outside CI", () => {
    expect(ciRunIdFromEnv({})).toBeUndefined();
  });
});
