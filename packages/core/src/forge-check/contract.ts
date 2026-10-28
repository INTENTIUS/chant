/**
 * The forge check's contract (#4608): each job a pipeline runs, the OIDC
 * token it presents, and the identities it trades that token for, with the
 * branches and statuses the forge should protect. The check compares the
 * live forge, the clouds and Pulumi Cloud with it.
 *
 * A product builds the contract from its own config, or chant builds it
 * from `ci.identity.cloud` with {@link pipelineContract}: per pipeline, a
 * plan job on the pull request, a record job on the default branch with the
 * plan identities, and an apply job on the default branch (or in its forge
 * environment) with the apply identities, as chant's generated pipelines
 * run them (../ci-identity.ts).
 *
 * Subjects, by forge (terragucci's `identities.ts`, lifted here):
 *
 *   GitHub   repo:ORG/REPO:pull_request, repo:ORG/REPO:environment:NAME,
 *            repo:ORG/REPO:ref:refs/heads/BRANCH; issuer
 *            https://token.actions.githubusercontent.com, or
 *            https://<host>/_services/token on GitHub Enterprise Server
 *   GitLab   project_path:GROUP/PROJECT:ref_type:branch:ref:BRANCH; a merge
 *            request pipeline's ref is its source branch, so the plan job's
 *            subject is a pattern over every branch. A job in a forge
 *            environment also carries `environment`, `environment_protected`
 *            and `ref_protected`. The issuer is the instance's URL.
 *   Forgejo  repo:<owner>-<owner id>/<repo>-<repo id>:ref:refs/heads/BRANCH,
 *            and :pull_request for a pull request; the issuer is
 *            <origin>/api/actions. No claim tells environments apart.
 */

import type { PipelineCloudIdentity, CloudTradeSpec, IdentityCloud } from "../ci-identity";
import { productStatusContext, resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import type { ForgeKind } from "../pr-forge";

/** What a job's OIDC token says about it. */
export interface JobToken {
  issuer: string;
  /** The `sub` claim. With `pattern`, `*` stands for any text. */
  subject: string;
  pattern: boolean;
  /** Claims besides `sub` and `aud` a trust can check: GitLab's environment claims on a job in a forge environment. */
  claims: Record<string, string>;
  /** Parts of `subject` the contract could not know, written `<name>` (Forgejo's numeric ids before the repository is read). */
  placeholders: string[];
}

export interface ForgeCheckRepository {
  /** Lower-cased, such as `github.com`. */
  host: string;
  /** owner/name, or a GitLab project's full path. */
  path: string;
  defaultBranch: string;
  /** Forgejo's numeric ids, which its subjects hold. */
  ownerId?: string;
  repoId?: string;
}

export interface JobRunner {
  labels: string[];
  /** A GitHub runner group. */
  group?: string;
}

/** One job of the pipeline and the identities it trades for. */
export interface ForgeCheckJob {
  /** As rows name it, such as `production plan` or `prod/web up`. */
  name: string;
  /** Which of the rule's two identities the job takes. */
  identity: "plan" | "apply";
  token: JobToken;
  /** The forge environment the job runs in (GitHub and GitLab). */
  forgeEnvironment?: string;
  runner?: JobRunner;
  aws?: { roles: string[]; audience: string };
  gcp?: { provider: string; audience: string };
  azure?: { clientIds: string[]; audience: string };
  /** Pulumi Cloud (#4549): the access tokens the job trades for, such as `team:deployers`. */
  pulumi?: { organization: string; tokens: string[]; audience: string; apiUrl?: string };
}

export interface ForgeCheckContract {
  forge: ForgeKind;
  repository: ForgeCheckRepository;
  jobs: ForgeCheckJob[];
  /** Branches the forge should protect. Default: the default branch. */
  protectedBranches?: string[];
  /** Status contexts the default branch should require before a merge, such as `plywood/preview`. Default none. */
  requiredStatuses?: string[];
  /** GitLab: the variables the apply jobs read, each of which should be protected and scoped to their forge environment. */
  gitlabVariables?: string[];
}

/** What the forge's repository read adds to a contract: its default branch, full path and Forgejo's ids. */
export interface LiveRepository {
  defaultBranch?: string;
  path?: string;
  ownerId?: string;
  repoId?: string;
}

/** The token's issuer: GitHub's service for github.com and Enterprise Server's own, GitLab's instance, Forgejo's /api/actions. */
export function issuerOf(forge: ForgeKind, host: string): string {
  if (forge === "github") return host.toLowerCase() === "github.com" ? "https://token.actions.githubusercontent.com" : `https://${host}/_services/token`;
  if (forge === "gitlab") return `https://${host}`;
  return `https://${host}/api/actions`;
}

/** Where a job runs: on a pull request, or on a branch (with its forge environment). */
export type JobEvent = { on: "pull-request" } | { on: "branch"; branch?: string; forgeEnvironment?: string };

/** The token a job presents on `forge` for `repo` when it runs on `event`. */
export function jobToken(forge: ForgeKind, repo: ForgeCheckRepository, event: JobEvent): JobToken {
  const issuer = issuerOf(forge, repo.host);
  const placeholders = [...repo.path.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
  const branch = event.on === "branch" ? (event.branch ?? repo.defaultBranch) : repo.defaultBranch;
  const env = event.on === "branch" ? event.forgeEnvironment : undefined;
  if (forge === "github") {
    const base = `repo:${repo.path}`;
    const subject = event.on === "pull-request" ? `${base}:pull_request` : env ? `${base}:environment:${env}` : `${base}:ref:refs/heads/${branch}`;
    return { issuer, subject, pattern: false, claims: {}, placeholders };
  }
  if (forge === "gitlab") {
    const base = `project_path:${repo.path}:ref_type:branch:ref:`;
    if (event.on === "pull-request") return { issuer, subject: `${base}*`, pattern: true, claims: {}, placeholders };
    const claims: Record<string, string> = env ? { environment: env, environment_protected: "true", ref_protected: "true" } : {};
    return { issuer, subject: `${base}${branch}`, pattern: false, claims, placeholders };
  }
  const slash = repo.path.lastIndexOf("/");
  const owner = repo.path.slice(0, slash);
  const name = repo.path.slice(slash + 1);
  const ids = [...(repo.ownerId ? [] : ["owner-id"]), ...(repo.repoId ? [] : ["repo-id"])];
  const base = `repo:${owner}-${repo.ownerId ?? "<owner-id>"}/${name}-${repo.repoId ?? "<repo-id>"}`;
  const subject = event.on === "pull-request" ? `${base}:pull_request` : `${base}:ref:refs/heads/${branch}`;
  return { issuer, subject, pattern: false, claims: {}, placeholders: [...placeholders, ...ids] };
}

const own = <T>(id: T | undefined, targets: Array<Record<string, unknown>> | undefined, key: string): T[] => {
  const out: T[] = [];
  for (const v of [id, ...(targets ?? []).map((t) => t[key] as T | undefined)]) if (v !== undefined && !out.includes(v)) out.push(v);
  return out;
};

/** A job's identities, per cloud, from one side of a resolved trade. */
export function jobIdentities(spec: CloudTradeSpec): Pick<ForgeCheckJob, IdentityCloud> {
  return {
    ...(spec.aws ? { aws: { roles: own(spec.aws.role, spec.aws.targets, "role"), audience: spec.aws.audience } } : {}),
    ...(spec.gcp ? { gcp: { provider: spec.gcp.provider, audience: spec.gcp.audience } } : {}),
    ...(spec.azure ? { azure: { clientIds: own(spec.azure.clientId, spec.azure.targets, "clientId"), audience: spec.azure.audience } } : {}),
    ...(spec.pulumi
      ? { pulumi: { organization: spec.pulumi.organization, tokens: own(spec.pulumi.token, spec.pulumi.targets, "token"), audience: spec.pulumi.audience, ...(spec.pulumi.apiUrl ? { apiUrl: spec.pulumi.apiUrl } : {}) } }
      : {}),
  };
}

/** One generated pipeline: an environment, and in a workspace a member, with the trades `resolveCloudIdentity` gives it. */
export interface ContractPipeline {
  /** As rows name its jobs: the environment, or `<member>/<environment>`. */
  name: string;
  identity: PipelineCloudIdentity;
  /** The member, whose status contexts carry its name. */
  member?: string;
  /** The forge environment the apply jobs run in (GitHub and GitLab). */
  forgeEnvironment?: string;
  /** The apply jobs' runner. */
  applyRunner?: JobRunner;
}

export interface PipelineContractInput {
  forge: ForgeKind;
  repository: ForgeCheckRepository;
  pipelines: ContractPipeline[];
  /** The product's words: the stage words in job names and the default required statuses. */
  words?: CiProductWordsInput | CiProductWords;
  /** Default: the default branch. */
  protectedBranches?: string[];
  /** Default: each pipeline's plan status, such as `chant/plan` or `plywood/preview/<member>`. */
  requiredStatuses?: string[];
  gitlabVariables?: string[];
}

/**
 * The contract of chant's generated pull-request pipelines: per pipeline,
 * the plan job (pull request, plan identities), the record job (default
 * branch, plan identities) and the apply job (default branch or its forge
 * environment, apply identities). A Forgejo forge has no environments, so
 * `forgeEnvironment` is left out there.
 */
export function pipelineContract(input: PipelineContractInput): ForgeCheckContract {
  const words = resolveProductWords(input.words);
  const { forge, repository } = input;
  const jobs: ForgeCheckJob[] = [];
  const statuses: string[] = [];
  for (const p of input.pipelines) {
    const env = forge === "forgejo" ? undefined : p.forgeEnvironment;
    jobs.push({ name: `${p.name} ${words.stages.plan}`, identity: "plan", token: jobToken(forge, repository, { on: "pull-request" }), ...jobIdentities(p.identity.plan) });
    jobs.push({ name: `${p.name} ${words.stages.record}`, identity: "plan", token: jobToken(forge, repository, { on: "branch" }), ...jobIdentities(p.identity.plan) });
    jobs.push({
      name: `${p.name} ${words.stages.apply}`,
      identity: "apply",
      token: jobToken(forge, repository, { on: "branch", ...(env ? { forgeEnvironment: env } : {}) }),
      ...(env ? { forgeEnvironment: env } : {}),
      ...(p.applyRunner ? { runner: p.applyRunner } : {}),
      ...jobIdentities(p.identity.apply),
    });
    const ctx = productStatusContext(words, "plan", p.member);
    if (!statuses.includes(ctx)) statuses.push(ctx);
  }
  return {
    forge,
    repository,
    jobs,
    protectedBranches: input.protectedBranches ?? [repository.defaultBranch],
    requiredStatuses: input.requiredStatuses ?? statuses,
    ...(input.gitlabVariables ? { gitlabVariables: input.gitlabVariables } : {}),
  };
}
