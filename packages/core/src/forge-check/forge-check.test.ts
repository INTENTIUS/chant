/**
 * #4608: the forge and trust-policy check. Every forge, cloud and Pulumi
 * Cloud answer comes from a recorded-answer fake fetch; nothing leaves the
 * process, and no test reaches a real forge or cloud.
 */

import { describe, expect, test } from "vitest";
import type { PipelineCloudIdentity } from "../ci-identity";
import type { ForgeFetch, ForgeTarget } from "../pr-forge";
import {
  assertReadOnly,
  awsTrustPolicy,
  celNarrowerOrEqual,
  describeForgeCheck,
  forgeCheck,
  forgeCheckExit,
  forgeCheckTarget,
  gcpCondition,
  jobToken,
  pipelineContract,
  readOnly,
  ReadOnlyError,
  type CheckRow,
  type ForgeCheckContract,
  type ForgeCheckRepository,
  type LiveRepository,
} from "./index";

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });

/**
 * A fetch answering from `answers` by URL without page parameters (a GetRole
 * by `role:<name>`), recording each call. A URL with no answer is a 404.
 */
function recorded(answers: Record<string, Answer>): { fetch: ForgeFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const role = /Action=GetRole&RoleName=([^&]+)/.exec(init.body ?? "")?.[1];
    const u = new URL(url);
    const page = Number(u.searchParams.get("page") ?? "1");
    for (const p of ["page", "per_page", "limit"]) u.searchParams.delete(p);
    const key = role ? `role:${decodeURIComponent(role)}` : `${u.origin}${u.pathname}${u.search}`;
    const a = answers[key] ?? { status: 404, body: { message: "Not Found" } };
    const body = Array.isArray(a.body) && page > 1 ? [] : a.body;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => text };
  };
  return { fetch, calls };
}

/** GetRole's answer, as IAM's Query API sends it: the trust policy URL-encoded. */
const getRole = (name: string, policy: string): Answer =>
  ok(`<GetRoleResponse><GetRoleResult><Role><AssumeRolePolicyDocument>${encodeURIComponent(policy)}</AssumeRolePolicyDocument><RoleName>${name}</RoleName></Role></GetRoleResult></GetRoleResponse>`);

const row = (rows: CheckRow[], where: string, check: string, subject: string): CheckRow => {
  const r = rows.find((x) => x.where === where && x.check === check && x.subject === subject);
  if (!r) throw new Error(`no row ${where} ${check} ${subject} in ${JSON.stringify(rows, null, 2)}`);
  return r;
};

/** Every call was a read: GET, or a POST of GetRole. */
const allReads = (calls: string[]): boolean => calls.every((c) => c.startsWith("GET ") || c.startsWith("POST https://iam."));

const GH = "https://api.github.com";
const GH_TARGET: ForgeTarget = { kind: "github", apiBase: GH, repo: "acme/infra", host: "github.com", token: "t", tokenSource: "GH_TOKEN" };
const PLAN_ROLE = "arn:aws:iam::123456789012:role/plan";
const APPLY_ROLE = "arn:aws:iam::123456789012:role/apply";
const AWS_ENV = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SHARED_CREDENTIALS_FILE: "/nonexistent" };
const NO_CREDS = { AWS_SHARED_CREDENTIALS_FILE: "/nonexistent", HOME: "/nonexistent" };

const awsIdentity: PipelineCloudIdentity = {
  plan: { aws: { role: PLAN_ROLE, region: "us-east-1", audience: "sts.amazonaws.com" } },
  apply: { aws: { role: APPLY_ROLE, region: "us-east-1", audience: "sts.amazonaws.com" } },
};

const PULUMI_API = "http://127.0.0.1:9/pulumi";
const pulumiIdentity: PipelineCloudIdentity = {
  plan: { pulumi: { token: "team:previewers", organization: "acme", audience: "urn:pulumi:org:acme", apiUrl: PULUMI_API } },
  apply: { pulumi: { token: "team:deployers", organization: "acme", audience: "urn:pulumi:org:acme", apiUrl: PULUMI_API } },
};

const repo = (live: LiveRepository = {}): ForgeCheckRepository => ({ host: "github.com", path: live.path ?? "acme/infra", defaultBranch: live.defaultBranch ?? "main" });

/** The contract chant builds for one production pipeline, on the live repository. */
const contractFor =
  (identity: PipelineCloudIdentity, words?: { product: string; stages?: Record<string, string> }) =>
  (live: LiveRepository): ForgeCheckContract =>
    pipelineContract({ forge: "github", repository: repo(live), pipelines: [{ name: "production", identity }], ...(words ? { words } : {}) });

/** A GitHub setup that holds what the contract wants: main protected, chant/plan required and posted, each role trusted to its jobs. */
function githubSetup(contract: ForgeCheckContract, policies: Partial<Record<string, string>> = {}): Record<string, Answer> {
  const tokens = (id: "plan" | "apply") => contract.jobs.filter((j) => j.identity === id).map((j) => ({ token: j.token, audience: "sts.amazonaws.com" }));
  return {
    [`${GH}/repos/acme/infra`]: ok({ id: 1, full_name: "acme/infra", default_branch: "main" }),
    [`${GH}/repos/acme/infra/branches/main`]: ok({ name: "main", commit: { sha: "abc123def4567890" }, protected: true, protection: { enabled: true, required_status_checks: { contexts: ["chant/plan"], checks: [{ context: "chant/plan" }] } } }),
    [`${GH}/repos/acme/infra/rules/branches/main`]: ok([{ type: "pull_request" }]),
    [`${GH}/repos/acme/infra/commits/abc123def4567890/statuses`]: ok([{ id: 1, context: "chant/plan", state: "success" }]),
    "role:plan": getRole("plan", policies.plan ?? awsTrustPolicy(tokens("plan"), PLAN_ROLE)),
    "role:apply": getRole("apply", policies.apply ?? awsTrustPolicy(tokens("apply"), APPLY_ROLE)),
  };
}

describe("read-only (#4608)", () => {
  test("GET, HEAD and a POST of GetRole pass; every other request is refused", () => {
    expect(() => assertReadOnly("https://api.github.com/repos/o/r", "GET")).not.toThrow();
    expect(() => assertReadOnly("https://api.github.com/repos/o/r", "HEAD")).not.toThrow();
    expect(() => assertReadOnly("https://iam.amazonaws.com/", "POST", "Action=GetRole&RoleName=x&Version=2010-05-08")).not.toThrow();
    expect(() => assertReadOnly("https://iam.amazonaws.com/", "POST", "Action=UpdateAssumeRolePolicy&RoleName=x")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://iam.amazonaws.com/?Action=DeleteRole&RoleName=x", "GET")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://api.github.com/repos/o/r", "PATCH", "{}")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://api.github.com/repos/o/r", "DELETE")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://api.pulumi.com/api/orgs/acme/oidc/issuers", "POST", "{}")).toThrow(ReadOnlyError);
  });

  test("the wrapper refuses before the request is sent, naming the product's command", async () => {
    const { fetch, calls } = recorded({});
    const ro = readOnly(fetch, "plywood forge check");
    await expect(ro("https://api.github.com/repos/o/r", { method: "PUT", headers: {}, body: "{}" })).rejects.toThrow(/plywood forge check is read-only/);
    expect(calls).toEqual([]);
  });
});

describe("subjects (#4608)", () => {
  const r: ForgeCheckRepository = { host: "github.com", path: "acme/infra", defaultBranch: "main" };
  test("GitHub: the pull request, the branch, and an environment", () => {
    expect(jobToken("github", r, { on: "pull-request" }).subject).toBe("repo:acme/infra:pull_request");
    expect(jobToken("github", r, { on: "branch" }).subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(jobToken("github", r, { on: "branch", forgeEnvironment: "prod" }).subject).toBe("repo:acme/infra:environment:prod");
    expect(jobToken("github", r, { on: "branch" }).issuer).toBe("https://token.actions.githubusercontent.com");
    expect(jobToken("github", { ...r, host: "ghe.example.com" }, { on: "branch" }).issuer).toBe("https://ghe.example.com/_services/token");
  });

  test("GitLab: the merge request's subject is a pattern, and an environment adds its claims", () => {
    const g = { ...r, host: "gitlab.example.com", path: "group/sub/infra" };
    const plan = jobToken("gitlab", g, { on: "pull-request" });
    expect(plan).toMatchObject({ subject: "project_path:group/sub/infra:ref_type:branch:ref:*", pattern: true, issuer: "https://gitlab.example.com" });
    expect(jobToken("gitlab", g, { on: "branch", forgeEnvironment: "prod" }).claims).toEqual({ environment: "prod", environment_protected: "true", ref_protected: "true" });
  });

  test("Forgejo: the numeric ids, or placeholders before the repository is read", () => {
    const f = { ...r, host: "code.example.com" };
    expect(jobToken("forgejo", f, { on: "branch" })).toMatchObject({ subject: "repo:acme-<owner-id>/infra-<repo-id>:ref:refs/heads/main", placeholders: ["owner-id", "repo-id"] });
    expect(jobToken("forgejo", { ...f, ownerId: "7", repoId: "42" }, { on: "pull-request" })).toMatchObject({ subject: "repo:acme-7/infra-42:pull_request", placeholders: [], issuer: "https://code.example.com/api/actions" });
  });
});

describe("the contract chant's pipelines make (#4608)", () => {
  test("a plan job on the pull request, a record job and an apply job on the default branch", () => {
    const c = pipelineContract({ forge: "github", repository: repo(), pipelines: [{ name: "production", identity: awsIdentity }] });
    expect(c.jobs.map((j) => [j.name, j.identity, j.token.subject, j.aws?.roles])).toEqual([
      ["production plan", "plan", "repo:acme/infra:pull_request", [PLAN_ROLE]],
      ["production record", "plan", "repo:acme/infra:ref:refs/heads/main", [PLAN_ROLE]],
      ["production apply", "apply", "repo:acme/infra:ref:refs/heads/main", [APPLY_ROLE]],
    ]);
    expect(c.protectedBranches).toEqual(["main"]);
    expect(c.requiredStatuses).toEqual(["chant/plan"]);
  });

  test("a product's words name the jobs and the required status", () => {
    const c = pipelineContract({ forge: "github", repository: repo(), pipelines: [{ name: "dev", identity: pulumiIdentity, member: "web" }], words: { product: "plywood", stages: { plan: "preview", apply: "up" } } });
    expect(c.jobs.map((j) => j.name)).toEqual(["dev preview", "dev record", "dev up"]);
    expect(c.requiredStatuses).toEqual(["plywood/preview/web"]);
    expect(c.jobs[2]!.pulumi).toEqual({ organization: "acme", tokens: ["team:deployers"], audience: "urn:pulumi:org:acme", apiUrl: PULUMI_API });
  });

  test("Forgejo has no environments, so an apply environment is left out", () => {
    const c = pipelineContract({ forge: "forgejo", repository: { ...repo(), host: "code.example.com" }, pipelines: [{ name: "p", identity: awsIdentity, forgeEnvironment: "prod" }] });
    expect(c.jobs[2]!.forgeEnvironment).toBeUndefined();
  });
});

describe("GitHub and AWS (#4608)", () => {
  test("a setup that holds the contract matches, with reads alone", async () => {
    const contract = contractFor(awsIdentity)({});
    const { fetch, calls } = recorded(githubSetup(contract));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: AWS_ENV, readFile: () => undefined });
    expect(r.schema).toBe("chant.forge-check/v1");
    expect(row(r.rows, "github", "protected-branch", "main")).toMatchObject({ status: "match", found: "branch protection; rulesets: pull_request" });
    expect(row(r.rows, "github", "required-status", "chant/plan").status).toBe("match");
    expect(row(r.rows, "github", "status-reported", "chant/plan")).toMatchObject({ status: "match", found: "posted on abc123def456" });
    expect(row(r.rows, "aws", "trust", PLAN_ROLE).status).toBe("match");
    expect(row(r.rows, "aws", "trust", APPLY_ROLE).status).toBe("match");
    expect(r.ok).toBe(true);
    expect(forgeCheckExit(r)).toBe(0);
    expect(allReads(calls)).toBe(true);
  });

  test("an apply role that trusts the pull request's subject is a mismatch, and the check fails", async () => {
    const contract = contractFor(awsIdentity)({});
    const wide = awsTrustPolicy([...contract.jobs].map((j) => ({ token: j.token, audience: "sts.amazonaws.com" })), APPLY_ROLE);
    const { fetch } = recorded(githubSetup(contract, { apply: wide }));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: AWS_ENV, readFile: () => undefined });
    const apply = row(r.rows, "aws", "trust", APPLY_ROLE);
    expect(apply.status).toBe("mismatch");
    expect(apply.found).toMatch(/admits sub repo:acme\/infra:pull_request with aud sts.amazonaws.com, which no job of this role presents/);
    expect(r.ok).toBe(false);
    expect(forgeCheckExit(r)).toBe(1);
  });

  test("an unprotected branch with no required status is two mismatches, and a status not posted yet is unknown", async () => {
    const contract = contractFor(awsIdentity)({});
    const setup = githubSetup(contract);
    setup[`${GH}/repos/acme/infra/branches/main`] = ok({ name: "main", commit: { sha: "abc123def4567890" }, protected: false });
    setup[`${GH}/repos/acme/infra/rules/branches/main`] = ok([]);
    setup[`${GH}/repos/acme/infra/commits/abc123def4567890/statuses`] = ok([]);
    const { fetch } = recorded(setup);
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: AWS_ENV, readFile: () => undefined });
    expect(row(r.rows, "github", "protected-branch", "main")).toMatchObject({ status: "mismatch", found: "not protected" });
    expect(row(r.rows, "github", "required-status", "chant/plan")).toMatchObject({ status: "mismatch", found: "no required status" });
    expect(row(r.rows, "github", "status-reported", "chant/plan").status).toBe("unknown");
  });

  test("a required status from a ruleset counts", async () => {
    const contract = contractFor(awsIdentity)({});
    const setup = githubSetup(contract);
    setup[`${GH}/repos/acme/infra/branches/main`] = ok({ name: "main", commit: { sha: "abc123def4567890" }, protected: false });
    setup[`${GH}/repos/acme/infra/rules/branches/main`] = ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "chant/plan" }] } }]);
    const { fetch } = recorded(setup);
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: AWS_ENV, readFile: () => undefined });
    expect(row(r.rows, "github", "protected-branch", "main")).toMatchObject({ status: "match", found: "rulesets: required_status_checks" });
    expect(row(r.rows, "github", "required-status", "chant/plan").status).toBe("match");
  });

  test("an apply environment must exist and deploy from the default branch alone", async () => {
    const build = (live: LiveRepository) => pipelineContract({ forge: "github", repository: repo(live), pipelines: [{ name: "production", identity: awsIdentity, forgeEnvironment: "production", applyRunner: { labels: ["deploy"], group: "deployers" } }] });
    const setup = githubSetup(build({}));
    setup[`${GH}/repos/acme/infra/environments/production`] = ok({ name: "production", deployment_branch_policy: null });
    setup[`${GH}/orgs/acme/actions/runner-groups`] = ok({ runner_groups: [{ name: "deployers", restricted_to_workflows: false }] });
    const { fetch } = recorded(setup);
    const r = await forgeCheck({ target: GH_TARGET, contract: build }, { fetch, env: AWS_ENV, readFile: () => undefined });
    expect(row(r.rows, "github", "environment", "production").status).toBe("match");
    expect(row(r.rows, "github", "deployment-branches", "production")).toMatchObject({ status: "mismatch", found: "any branch: no deployment branch rule" });
    expect(row(r.rows, "github", "runner-group", "deployers")).toMatchObject({ status: "mismatch", found: "every workflow" });
    expect(build({}).jobs[2]!.token.subject).toBe("repo:acme/infra:environment:production");
  });

  test("no AWS credentials leave the roles unchecked, which fails only with requireClouds", async () => {
    const contract = contractFor(awsIdentity)({});
    const { fetch, calls } = recorded(githubSetup(contract));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: NO_CREDS, readFile: () => undefined });
    expect(row(r.rows, "aws", "trust", PLAN_ROLE).status).toBe("not-checked");
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes("iam."))).toBe(false);
    const strict = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity), requireClouds: true }, { fetch, env: NO_CREDS, readFile: () => undefined });
    expect(strict.ok).toBe(false);
  });

  test("an unreadable repository is one unknown row naming the token's variable", async () => {
    const { fetch } = recorded({ [`${GH}/repos/acme/infra`]: { status: 403, body: { message: "Forbidden" } } });
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: NO_CREDS, readFile: () => undefined });
    expect(row(r.rows, "github", "repository", "acme/infra")).toMatchObject({ status: "unknown" });
    expect(row(r.rows, "github", "repository", "acme/infra").found).toMatch(/in GH_TOKEN/);
  });
});

describe("Pulumi Cloud (#4608, #4549)", () => {
  const issuers = ok({ oidcIssuers: [{ id: "iss-1", name: "github", url: "https://token.actions.githubusercontent.com" }] });
  const policies = (extra: unknown[] = []) =>
    ok({
      policies: [
        { decision: "allow", tokenType: "team", teamName: "previewers", rules: { sub: "repo:acme/infra:pull_request" } },
        { decision: "allow", tokenType: "team", teamName: "previewers", rules: { sub: "repo:acme/infra:ref:refs/heads/main" } },
        { decision: "allow", tokenType: "team", teamName: "deployers", rules: { sub: "repo:acme/infra:ref:refs/heads/main", aud: "urn:pulumi:org:acme" } },
        ...extra,
      ],
    });
  const words = { product: "plywood", stages: { plan: "preview", apply: "up" } };
  const setup = (p: Answer, list: Answer = issuers): Record<string, Answer> => {
    const s = githubSetup(contractFor(pulumiIdentity, words)({}));
    s[`${GH}/repos/acme/infra/branches/main`] = ok({ name: "main", commit: { sha: "abc123def4567890" }, protected: true, protection: { required_status_checks: { contexts: ["plywood/preview"] } } });
    s[`${GH}/repos/acme/infra/commits/abc123def4567890/statuses`] = ok([{ id: 1, context: "plywood/preview", state: "success" }]);
    return { ...s, [`${PULUMI_API}/api/orgs/acme/oidc/issuers`]: list, [`${PULUMI_API}/api/orgs/acme/auth/policies/oidcissuers/iss-1`]: p };
  };

  test("the issuer is registered and each token is granted to its own jobs alone", async () => {
    const { fetch, calls } = recorded(setup(policies()));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(pulumiIdentity, words), words }, { fetch, env: { ...NO_CREDS, PULUMI_ACCESS_TOKEN: "pul-test" }, readFile: () => undefined });
    expect(r.schema).toBe("plywood.forge-check/v1");
    expect(row(r.rows, "pulumi", "oidc-issuer", "acme https://token.actions.githubusercontent.com")).toMatchObject({ status: "match", found: "registered as github" });
    expect(row(r.rows, "pulumi", "trust", "acme team:previewers").status).toBe("match");
    expect(row(r.rows, "pulumi", "trust", "acme team:deployers").status).toBe("match");
    expect(row(r.rows, "github", "required-status", "plywood/preview").status).toBe("match");
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.includes(PULUMI_API)).every((c) => c.startsWith("GET "))).toBe(true);
  });

  test("the up token granted to every branch of the repository is wider than its job", async () => {
    const { fetch } = recorded(setup(policies([{ decision: "allow", tokenType: "team", teamName: "deployers", rules: { sub: "repo:acme/infra:*" } }])));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(pulumiIdentity, words), words }, { fetch, env: { ...NO_CREDS, PULUMI_ACCESS_TOKEN: "pul-test" }, readFile: () => undefined });
    const up = row(r.rows, "pulumi", "trust", "acme team:deployers");
    expect(up.status).toBe("mismatch");
    expect(up.found).toMatch(/grants team:deployers to sub repo:acme\/infra:\* \(like\), which no job that takes it presents/);
    expect(r.ok).toBe(false);
  });

  test("a policy with no sub rule admits any subject", async () => {
    const { fetch } = recorded(setup(ok({ policies: [{ decision: "allow", tokenType: "team", teamName: "previewers", rules: {} }] })));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(pulumiIdentity, words), words }, { fetch, env: { ...NO_CREDS, PULUMI_ACCESS_TOKEN: "pul-test" }, readFile: () => undefined });
    expect(row(r.rows, "pulumi", "trust", "acme team:previewers").found).toMatch(/no sub rule/);
    expect(row(r.rows, "pulumi", "trust", "acme team:deployers")).toMatchObject({ status: "mismatch" });
  });

  test("an unregistered forge is a mismatch on the issuer and on each token", async () => {
    const { fetch } = recorded(setup(policies(), ok({ oidcIssuers: [] })));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(pulumiIdentity, words), words }, { fetch, env: { ...NO_CREDS, PULUMI_ACCESS_TOKEN: "pul-test" }, readFile: () => undefined });
    expect(row(r.rows, "pulumi", "oidc-issuer", "acme https://token.actions.githubusercontent.com")).toMatchObject({ status: "mismatch", found: "not registered" });
    expect(row(r.rows, "pulumi", "trust", "acme team:deployers")).toMatchObject({ status: "mismatch", found: "the forge is not a registered issuer" });
  });

  test("with no Pulumi token nothing is read from Pulumi Cloud, and requireClouds fails it", async () => {
    const { fetch, calls } = recorded(setup(policies()));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(pulumiIdentity, words), words, requireClouds: true }, { fetch, env: NO_CREDS, readFile: () => undefined });
    expect(row(r.rows, "pulumi", "trust", "acme team:previewers").status).toBe("not-checked");
    expect(calls.some((c) => c.includes(PULUMI_API))).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("GitLab (#4608)", () => {
  const API = "https://gitlab.example.com/api/v4";
  const target: ForgeTarget = { kind: "gitlab", apiBase: API, repo: "group/infra", host: "gitlab.example.com", token: "t", tokenSource: "GITLAB_TOKEN", tokenHeader: "PRIVATE-TOKEN" };
  const P = `${API}/projects/group%2Finfra`;
  const build = (live: LiveRepository) =>
    pipelineContract({ forge: "gitlab", repository: { host: "gitlab.example.com", path: live.path ?? "group/infra", defaultBranch: live.defaultBranch ?? "main" }, pipelines: [{ name: "prod", identity: awsIdentity, forgeEnvironment: "prod", applyRunner: { labels: ["deploy"] } }], gitlabVariables: ["SLACK_WEBHOOK"] });

  test("protected environment, runners, variables, branch, and pipelines that must succeed", async () => {
    const { fetch, calls } = recorded({
      [P]: ok({ id: 9, path_with_namespace: "group/infra", default_branch: "main", only_allow_merge_if_pipeline_succeeds: true, allow_merge_on_skipped_pipeline: false }),
      [`${P}/protected_environments`]: ok([{ name: "prod" }]),
      [`${P}/runners?tag_list=deploy`]: ok([{ id: 4, description: "deployer" }]),
      [`${API}/runners/4`]: ok({ access_level: "ref_protected" }),
      [`${P}/variables`]: ok([{ key: "SLACK_WEBHOOK", protected: true, environment_scope: "prod" }]),
      [`${P}/protected_branches`]: ok([{ name: "main" }]),
      [`${P}/repository/branches/main`]: ok({ commit: { id: "fedcba9876543210" } }),
      [`${P}/repository/commits/fedcba9876543210/statuses?all=true&ref=main`]: ok([{ id: 2, name: "chant/plan", status: "success" }]),
    });
    const r = await forgeCheck({ target, contract: build }, { fetch, env: NO_CREDS, readFile: () => undefined });
    for (const [check, subject] of [["protected-environment", "prod"], ["protected-runners", "tags deploy"], ["variable", "SLACK_WEBHOOK in prod"], ["protected-branch", "main"], ["required-status", "chant/plan"], ["status-reported", "chant/plan"]] as const) {
      expect(row(r.rows, "gitlab", check, subject).status).toBe("match");
    }
    expect(build({}).jobs[2]!.token).toMatchObject({ subject: "project_path:group/infra:ref_type:branch:ref:main", claims: { environment: "prod" } });
    expect(allReads(calls)).toBe(true);
  });

  test("a project that merges on a failed pipeline does not hold the required status", async () => {
    const { fetch } = recorded({ [P]: ok({ path_with_namespace: "group/infra", default_branch: "main", only_allow_merge_if_pipeline_succeeds: false }), [`${P}/protected_branches`]: ok([{ name: "ma*" }]) });
    const r = await forgeCheck({ target, contract: build }, { fetch, env: NO_CREDS, readFile: () => undefined });
    expect(row(r.rows, "gitlab", "required-status", "chant/plan")).toMatchObject({ status: "mismatch", found: "a merge request may merge with a failed pipeline" });
    expect(row(r.rows, "gitlab", "protected-branch", "main")).toMatchObject({ status: "match", found: "protected by ma*" });
    expect(row(r.rows, "gitlab", "protected-environment", "prod").status).toBe("unknown");
  });
});

describe("Forgejo (#4608)", () => {
  const API = "https://code.example.com/api/v1";
  const target: ForgeTarget = { kind: "forgejo", apiBase: API, repo: "acme/infra", host: "code.example.com", token: "t", tokenSource: "FORGEJO_TOKEN" };
  const build = (live: LiveRepository) =>
    pipelineContract({ forge: "forgejo", repository: { host: "code.example.com", path: "acme/infra", defaultBranch: live.defaultBranch ?? "main", ...(live.ownerId ? { ownerId: live.ownerId } : {}), ...(live.repoId ? { repoId: live.repoId } : {}) }, pipelines: [{ name: "p", identity: awsIdentity }] });

  test("the subjects take the ids the repository read gives, and the rule must check the status", async () => {
    const contract = build({ defaultBranch: "main", ownerId: "7", repoId: "42" });
    const { fetch } = recorded({
      [`${API}/repos/acme/infra`]: ok({ id: 42, full_name: "acme/infra", default_branch: "main", owner: { id: 7 } }),
      [`${API}/repos/acme/infra/branch_protections`]: ok([{ rule_name: "main", enable_status_check: true, status_check_contexts: ["chant/*"] }]),
      [`${API}/repos/acme/infra/branches/main`]: ok({ commit: { id: "0123456789abcdef" } }),
      [`${API}/repos/acme/infra/commits/0123456789abcdef/statuses`]: ok([{ id: 1, context: "chant/plan", status: "success" }]),
      "role:plan": getRole("plan", awsTrustPolicy(contract.jobs.filter((j) => j.identity === "plan").map((j) => ({ token: j.token, audience: "sts.amazonaws.com" })), PLAN_ROLE)),
      "role:apply": getRole("apply", awsTrustPolicy(contract.jobs.filter((j) => j.identity === "apply").map((j) => ({ token: j.token, audience: "sts.amazonaws.com" })), APPLY_ROLE)),
    });
    const r = await forgeCheck({ target, contract: build }, { fetch, env: AWS_ENV, readFile: () => undefined });
    expect(row(r.rows, "forgejo", "protected-branch", "main").status).toBe("match");
    expect(row(r.rows, "forgejo", "required-status", "chant/plan")).toMatchObject({ status: "match", found: "required: chant/*" });
    expect(row(r.rows, "aws", "trust", APPLY_ROLE).status).toBe("match");
    expect(row(r.rows, "aws", "trust", APPLY_ROLE).expected).toContain("repo:acme-7/infra-42:ref:refs/heads/main");
  });
});

describe("GCP and Azure (#4608)", () => {
  const PROVIDER = "projects/123/locations/global/workloadIdentityPools/ci/providers/github";
  const identity: PipelineCloudIdentity = {
    plan: { gcp: { serviceAccount: "plan@p.iam.gserviceaccount.com", provider: PROVIDER, audience: `https://iam.googleapis.com/${PROVIDER}` }, azure: { clientId: "plan-app", tenantId: "t", audience: "api://AzureADTokenExchange" } },
    apply: { gcp: { serviceAccount: "apply@p.iam.gserviceaccount.com", provider: PROVIDER, audience: `https://iam.googleapis.com/${PROVIDER}` }, azure: { clientId: "apply-app", tenantId: "t", audience: "api://AzureADTokenExchange" } },
  };
  const cred = (subject: string) => ({ name: "x", issuer: "https://token.actions.githubusercontent.com", subject, audiences: ["api://AzureADTokenExchange"] });

  test("a provider condition as narrow as the jobs matches, and an app with an extra credential is wider", async () => {
    const contract = contractFor(identity)({});
    const condition = gcpCondition(contract.jobs.map((j) => j.token));
    const setup = githubSetup(contract);
    const { fetch } = recorded({
      ...setup,
      [`https://iam.googleapis.com/v1/${PROVIDER}`]: ok({ attributeCondition: condition }),
      "https://graph.microsoft.com/v1.0/applications(appId='plan-app')/federatedIdentityCredentials": ok({ value: [cred("repo:acme/infra:pull_request"), cred("repo:acme/infra:ref:refs/heads/main")] }),
      "https://graph.microsoft.com/v1.0/applications(appId='apply-app')/federatedIdentityCredentials": ok({ value: [cred("repo:acme/infra:ref:refs/heads/main"), cred("repo:acme/infra:pull_request")] }),
    });
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(identity) }, { fetch, env: { ...NO_CREDS, GOOGLE_OAUTH_ACCESS_TOKEN: "g", AZURE_GRAPH_TOKEN: "a" }, readFile: () => undefined });
    expect(row(r.rows, "gcp", "trust", PROVIDER).status).toBe("match");
    expect(row(r.rows, "azure", "trust", "plan-app").status).toBe("match");
    expect(row(r.rows, "azure", "trust", "apply-app")).toMatchObject({ status: "mismatch" });
    expect(row(r.rows, "azure", "trust", "apply-app").found).toMatch(/wider: x: issuer https:\/\/token.actions.githubusercontent.com subject repo:acme\/infra:pull_request/);
  });

  test("a CEL condition is compared term by term", () => {
    expect(celNarrowerOrEqual("assertion.sub == 'a' && assertion.ref_protected == 'true'", "assertion.sub == 'a'")).toBe(true);
    expect(celNarrowerOrEqual("assertion.sub == 'a' || assertion.sub == 'b'", "assertion.sub == 'a'")).toBe(false);
  });
});

describe("the table and the target (#4608)", () => {
  test("the table ends with the counts", async () => {
    const { fetch } = recorded(githubSetup(contractFor(awsIdentity)({})));
    const r = await forgeCheck({ target: GH_TARGET, contract: contractFor(awsIdentity) }, { fetch, env: NO_CREDS, readFile: () => undefined });
    const text = describeForgeCheck(r);
    expect(text.split("\n")[0]).toBe("github github.com/acme/infra (default branch main)");
    expect(text).toMatch(/WHERE\s+CHECK\s+SUBJECT\s+EXPECTED\s+FOUND\s+MATCH/);
    expect(text.split("\n").at(-1)).toBe(`${r.counts.match} match, ${r.counts.mismatch} mismatch, ${r.counts.unknown} could not be read, ${r.counts["not-checked"]} not checked`);
  });

  test("the target comes from a laptop's flags and token, or a job's environment", () => {
    expect(forgeCheckTarget({ GH_TOKEN: "x" }, { kind: "github", repo: "acme/infra" })).toMatchObject({ kind: "github", apiBase: "https://api.github.com", repo: "acme/infra", host: "github.com", tokenSource: "GH_TOKEN" });
    expect(forgeCheckTarget({ GITLAB_CI: "true", CI_SERVER_URL: "https://gitlab.example.com", CI_PROJECT_PATH: "g/p", CI_JOB_TOKEN: "j" })).toMatchObject({ kind: "gitlab", apiBase: "https://gitlab.example.com/api/v4", repo: "g/p", tokenHeader: "JOB-TOKEN" });
    expect(forgeCheckTarget({ FORGEJO_SERVER_URL: "https://code.example.com", FORGEJO_REPOSITORY: "a/b", FORGEJO_TOKEN: "f" })).toMatchObject({ kind: "forgejo", apiBase: "https://code.example.com/api/v1", host: "code.example.com" });
    expect(() => forgeCheckTarget({}, {})).toThrow(/--forge/);
  });
});
