/**
 * #5170: the forge apart from the CI system. Each forge's CI system defaults
 * to its own, `forge: github` takes `ci: prow`, the forge reads in a Prow job
 * use GitHub with Prow's variables, and the configs that name both fields
 * read them.
 */
import { describe, expect, test } from "vitest";
import { CI_SYSTEMS, defaultCiOf, defaultForgeOf, ForgeCiError, forgeCiProblem, pipelineLexiconOf, resolveForgeCi } from "./ci-system";
import { ChantConfigSchema, environmentExecutor } from "./config";
import { detectCi } from "./ci-detect";
import { detectForge, ForgeEnvironmentError, forgeTargetFromEnv, prowJobOf, type ForgeKind } from "./pr-forge";
import { pullRequestBaseFromEnv } from "./pr-forge-base";
import { parseDeclaration, WorkspaceReadError } from "./workspace/declaration";
import { generateTargetProblem } from "./workspace/ci-forge";
import { executorFor } from "./workspace/environments";

/** A Prow presubmit's pod, as Prow's pod utilities set it, with the GitHub token a Secret mounts. */
const PROW_PRESUBMIT = {
  PROW_JOB_ID: "6a0e2d14-0000-4000-8000-000000000001",
  JOB_TYPE: "presubmit",
  JOB_NAME: "acme-plan",
  BUILD_ID: "1",
  REPO_OWNER: "acme",
  REPO_NAME: "infra",
  PULL_BASE_REF: "main",
  PULL_BASE_SHA: "b".repeat(40),
  PULL_NUMBER: "42",
  PULL_PULL_SHA: "a".repeat(40),
  GITHUB_TOKEN: "ghs_x",
};

describe("each forge's CI system defaults to its own", () => {
  test.each(["github", "gitlab", "forgejo"] as ForgeKind[])("%s", (forge) => {
    expect(defaultCiOf(forge)).toBe(forge);
    expect(resolveForgeCi({ forge })).toEqual({ forge, ci: forge });
    expect(resolveForgeCi({ forge, ci: forge })).toEqual({ forge, ci: forge });
    expect(pipelineLexiconOf(defaultCiOf(forge))).toBe(forge);
  });

  test("each CI system names the forge it serves when nothing names one", () => {
    expect(CI_SYSTEMS.map(defaultForgeOf)).toEqual(["github", "gitlab", "forgejo", "github"]);
  });
});

describe("forge: github with ci: prow", () => {
  test("is a pair that runs, and its pipeline is the prow lexicon's", () => {
    expect(resolveForgeCi({ forge: "github", ci: "prow" })).toEqual({ forge: "github", ci: "prow" });
    expect(forgeCiProblem("github", "prow")).toBeUndefined();
    expect(pipelineLexiconOf("prow")).toBe("prow");
  });

  test("prow on another forge, and one forge's CI on another, are refused", () => {
    expect(() => resolveForgeCi({ forge: "gitlab", ci: "prow" })).toThrow(ForgeCiError);
    expect(() => resolveForgeCi({ forge: "forgejo", ci: "prow" })).toThrow(/runs jobs for a repository on github, and this forge is forgejo/);
    expect(forgeCiProblem("github", "gitlab")).toMatch(/runs jobs for a repository on gitlab/);
  });
});

describe("a job's CI system and forge, from its environment", () => {
  test("GitHub Actions, GitLab CI and Forgejo Actions are their forge's own", () => {
    expect(detectCi({ GITHUB_ACTIONS: "true" })).toBe("github");
    expect(detectCi({ GITLAB_CI: "true" })).toBe("gitlab");
    expect(detectCi({ FORGEJO_ACTIONS: "true" })).toBe("forgejo");
    expect(detectCi({})).toBeUndefined();
  });

  test("a Prow job's CI is prow and its forge is GitHub", () => {
    expect(detectCi(PROW_PRESUBMIT)).toBe("prow");
    expect(detectForge(PROW_PRESUBMIT)).toBe("github");
    expect(prowJobOf(PROW_PRESUBMIT)).toEqual({ repo: "acme/infra", pr: 42, sha: "a".repeat(40) });
  });

  test("Prow's variables count only in a Prow job", () => {
    const { PROW_JOB_ID: _, ...notProw } = PROW_PRESUBMIT;
    expect(prowJobOf(notProw)).toBeUndefined();
    expect(detectForge(notProw)).toBeUndefined();
    expect(() => forgeTargetFromEnv(notProw, { kind: "github" })).toThrow(/--forge github needs GITHUB_REPOSITORY in the environment/);
  });
});

describe("the forge reads in a Prow job use GitHub with Prow's variables", () => {
  test("the target is the GitHub repository, pull request and head Prow names", () => {
    const t = forgeTargetFromEnv(PROW_PRESUBMIT);
    expect(t).toMatchObject({ kind: "github", apiBase: "https://api.github.com", repo: "acme/infra", host: "github.com", pr: 42, sha: "a".repeat(40), tokenSource: "GITHUB_TOKEN" });
  });

  test("a postsubmit has no pull request, and its commit is the base", () => {
    const { PULL_NUMBER: _n, PULL_PULL_SHA: _s, ...postsubmit } = { ...PROW_PRESUBMIT, JOB_TYPE: "postsubmit" };
    const t = forgeTargetFromEnv(postsubmit, { kind: "github" });
    expect(t.pr).toBeUndefined();
    expect(t.sha).toBe("b".repeat(40));
    expect(() => forgeTargetFromEnv(postsubmit, { kind: "github", requirePr: true })).toThrow(/PULL_NUMBER from a Prow presubmit/);
  });

  test("GITHUB_* variables the job sets win over Prow's", () => {
    const t = forgeTargetFromEnv({ ...PROW_PRESUBMIT, GITHUB_REPOSITORY: "acme/mirror", GITHUB_REF: "refs/pull/7/merge", GITHUB_SHA: "c".repeat(40) }, { kind: "github" });
    expect(t).toMatchObject({ repo: "acme/mirror", pr: 7, sha: "c".repeat(40) });
  });

  test("a Prow job with no repository says what to set", () => {
    const { REPO_OWNER: _, ...periodic } = PROW_PRESUBMIT;
    expect(() => forgeTargetFromEnv(periodic, { kind: "github" })).toThrow(ForgeEnvironmentError);
    expect(() => forgeTargetFromEnv(periodic, { kind: "github" })).toThrow(/GITHUB_REPOSITORY, or REPO_OWNER and REPO_NAME from Prow/);
  });

  test("the pull request's base is read from the repository Prow names", async () => {
    const urls: string[] = [];
    const base = pullRequestBaseFromEnv("github", PROW_PRESUBMIT, async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ base: { ref: "main" } }) };
    });
    expect(await base!(42)).toBe("main");
    expect(urls).toEqual(["https://api.github.com/repos/acme/infra/pulls/42"]);
  });
});

describe("the workspace declaration's ci.forge and ci.system", () => {
  const parse = (ci?: unknown) => parseDeclaration(JSON.stringify({ name: "acme", schema: 1, ...(ci ? { ci } : {}), members: [] }, null, 2), "chant.workspace.json");

  test("forge: github with system: prow", () => {
    expect(parse({ forge: "github", system: "prow" }).ci?.forgeCi).toEqual({ forge: "github", ci: "prow" });
  });

  test("each forge alone takes its own CI system, and prow alone takes github", () => {
    for (const forge of ["github", "gitlab", "forgejo"]) expect(parse({ forge }).ci?.forgeCi).toEqual({ forge, ci: forge });
    expect(parse({ system: "prow" }).ci?.forgeCi).toEqual({ forge: "github", ci: "prow" });
  });

  test("neither leaves the block as it was", () => {
    expect(parse({ locks: "plan" }).ci).not.toHaveProperty("forgeCi");
    expect(parse().ci).toBeNull();
  });

  test("a pair that cannot run, and an unknown system, are refused", () => {
    expect(() => parse({ forge: "gitlab", system: "prow" })).toThrow(WorkspaceReadError);
    expect(() => parse({ forge: "gitlab", system: "prow" })).toThrow(/ci\.system: prow runs jobs for a repository on github/);
    expect(() => parse({ system: "jenkins" })).toThrow(WorkspaceReadError);
  });

  test("--generate is refused for a CI system other than the declared one", () => {
    expect(generateTargetProblem("github", { forge: "github", ci: "prow" })).toMatch(/names ci\.system prow for the github forge, and --generate github/);
    expect(generateTargetProblem("prow", { forge: "github", ci: "prow" })).toBeUndefined();
    expect(generateTargetProblem("github", null)).toBeUndefined();
    expect(generateTargetProblem("aws", { forge: "github", ci: "prow" })).toBeUndefined();
  });
});

describe("an environment executor's ci in chant.config.ts", () => {
  test("takes prow beside github, and refuses it beside another forge", () => {
    expect(ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "github", ci: "prow", workflow: "prow/jobs.yaml" } }] }).success).toBe(true);
    const refused = ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "gitlab", ci: "prow", workflow: "prow/jobs.yaml" } }] });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toMatch(/runs jobs for a repository on github/);
    expect(ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "github", ci: "jenkins", workflow: "x.yml" } }] }).success).toBe(false);
  });

  test("the composites executor carries ci only when the config names it", () => {
    const member = (executor: unknown) => ({ declared: [{ name: "prod", executor }] }) as unknown as Parameters<typeof executorFor>[1];
    expect(executorFor("prod", member({ forge: "github", ci: "prow", workflow: "prow/jobs.yaml" }))).toEqual({ forge: "github", ci: "prow", workflow: "prow/jobs.yaml", reason: null });
    const plain = executorFor("prod", member({ forge: "github", workflow: "deploy-prod.yml" }));
    expect(plain).toEqual({ forge: "github", workflow: "deploy-prod.yml", reason: null });
    expect(JSON.stringify(plain)).toBe('{"forge":"github","workflow":"deploy-prod.yml","reason":null}');
    expect(environmentExecutor([{ name: "prod", executor: { forge: "github", workflow: "deploy-prod.yml" } }], "prod")).not.toHaveProperty("ci");
  });
});
