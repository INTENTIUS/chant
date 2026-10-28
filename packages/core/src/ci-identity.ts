/**
 * Plan and apply cloud identities (#4296): the pull-request jobs plan with
 * one identity and apply with another, per cloud, and the plan job trades
 * its OIDC token before the change's code is checked out.
 *
 * The workspace declaration's `ci.identity.cloud` gives each cloud a list of
 * rules. A rule names environment globs and member globs, and a plan and an
 * apply identity: an AWS role, a GCP service account or an Azure client id.
 * The first rule whose globs match the pipeline's environment and member is
 * the pipeline's ({@link resolveCloudIdentity}). A workspace generates one
 * pull-request pipeline per member and environment, so each member's apply
 * jobs hold that member's apply identity and no other.
 *
 * The plan job runs the pull request's code. Its first step, before the
 * checkout, runs {@link tradeJs} with `node -e`: it asks the forge for an
 * OIDC token, trades it for the plan identity's own credentials, and leaves
 * those credentials for the later steps. Each later step then starts again
 * without the variables a token is requested with ({@link OIDC_REQUEST_VARS},
 * through `dropForgeTokens` in ./ci-handover.ts), so the change's code holds
 * no OIDC token and cannot request one. The plan job's file names no apply
 * identity. The record job plans the merged commit with the plan identity,
 * and the apply jobs trade for the apply identity.
 *
 * Per target (#4332): a rule with `targets` covers only the targets those
 * globs match, the Terraform roots or Op wave runs inside one member, so
 * one member's targets can plan and apply as different identities. A
 * target takes the first rule that covers its environment, member and
 * target ({@link resolveTargetCloudIdentity}). The plan job then trades for
 * every plan identity the member's targets take, keeps the credentials of
 * each in a file named by {@link CLOUD_TARGETS_ENV}, and a product hands
 * each target's tool its own with {@link targetCloudEnv}. An apply splits
 * into one job per apply identity ({@link cloudIdentityGroups},
 * {@link cloudIdentityWave}), so no job holds two targets' apply tokens.
 *
 * The trade is terragucci's `oidc-trade.ts` (INTENTIUS/terragucci e6cb431,
 * packages/terragucci/src/oidc-trade.ts) with these clients:
 *
 *   AWS    STS AssumeRoleWithWebIdentity, as session keys in
 *          AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN
 *   GCP    Google's STS token exchange, then IAM generateAccessToken for the
 *          service account, in GOOGLE_OAUTH_ACCESS_TOKEN and
 *          CLOUDSDK_AUTH_ACCESS_TOKEN
 *   Azure  Entra's client credentials grant with the token as the client
 *          assertion, as an ARM access token in AZURE_ACCESS_TOKEN, with
 *          AZURE_CLIENT_ID and AZURE_TENANT_ID (and ARM_ spellings)
 *
 * terragucci leaves Azure untraded because the azurerm provider takes only
 * the OIDC token. chant trades it, so the change's code never holds a token
 * another client could be traded for; a tool that needs the OIDC token
 * itself cannot plan under this block.
 *
 * Pulumi Cloud (#4549) is traded the same way, through its OAuth token
 * exchange (`POST <apiUrl>/api/oauth/token`, RFC 8693), for a Pulumi access
 * token in PULUMI_ACCESS_TOKEN. Its identities name the token asked for:
 * `team:<name>`, `user:<login>`, `organization` or `organization:admin`. So
 * the plan and record jobs preview with one token, the apply jobs run `up`
 * with another, and the pull request's program never sees the `up` token.
 * No long-lived Pulumi token sits in the forge's secrets.
 */

import { readFileSync } from "node:fs";

/** The cloud providers `ci.identity.cloud` names. */
export const CLOUDS = ["aws", "gcp", "azure"] as const;
export type Cloud = (typeof CLOUDS)[number];

/**
 * Every key of `ci.identity.cloud`: the cloud providers and Pulumi Cloud
 * (#4549), whose access tokens are traded the same way. {@link CLOUDS}
 * keeps the providers alone, as a Terraform product reads them.
 */
export const IDENTITY_CLOUDS = [...CLOUDS, "pulumi"] as const;
export type IdentityCloud = (typeof IDENTITY_CLOUDS)[number];

/** The first chant that reads `ci.identity.cloud.pulumi` (#4549): a declaration that sets it needs this `minReader`. */
export const PULUMI_CLOUD_IDENTITY_FLOOR = "0.124.55";

/**
 * The first chant that reads `ci.identity.cloud.azure.database` (#4572): the
 * trade also asks Entra for a token Azure Database for PostgreSQL accepts.
 * A declaration that sets it needs this `minReader`.
 */
export const AZURE_DATABASE_TOKEN_FLOOR = "0.124.55";

/** The Entra scope of Azure Database for PostgreSQL's sign-in tokens (#4572). */
export const AZURE_DATABASE_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

/** The variable the trade sets to the database token with `azure.database` (#4572); the sql lexicon's `entra` token source reads it. */
export const AZURE_DATABASE_TOKEN_ENV = "AZURE_DATABASE_ACCESS_TOKEN";

/** One rule: the environments, members and targets it covers, and their two identities. */
export interface CloudIdentityRule {
  /** Environment-name globs. Absent: every environment. */
  environments?: string[];
  /** Member-name globs. Absent: every member, and a pipeline outside a workspace member. */
  members?: string[];
  /**
   * Target globs (#4332): the targets inside the member the rule covers,
   * such as Terraform roots or Op wave run targets. `*` matches within one
   * `/` segment, `**` across segments, `?` one character. Absent: every
   * target, and the pipeline as a whole.
   */
  targets?: string[];
  /** The name of the apply job group its targets form (#4332). Default: from its first target glob. */
  name?: string;
  /** The identity the plan and record jobs take. */
  plan: string;
  /** The identity the apply jobs take. */
  apply: string;
}

export interface AwsCloudIdentity {
  /** The STS region. Default `us-east-1`. */
  region?: string;
  /** The OIDC token's audience. Default `sts.amazonaws.com`. */
  audience?: string;
  /** The STS endpoint, for an emulator. Default the region's, or `AWS_ENDPOINT_URL_STS` in the job. */
  endpoint?: string;
  rules: CloudIdentityRule[];
}

export interface GcpCloudIdentity {
  /** The workload identity provider: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  provider: string;
  /** The OIDC token's audience. Default `https://iam.googleapis.com/<provider>`. */
  audience?: string;
  /** Google's STS, for an emulator. Default `https://sts.googleapis.com`. */
  stsEndpoint?: string;
  /** IAM credentials, for an emulator. Default `https://iamcredentials.googleapis.com`. */
  iamEndpoint?: string;
  rules: CloudIdentityRule[];
}

export interface AzureCloudIdentity {
  /** The Entra tenant. */
  tenantId: string;
  /** Set as AZURE_SUBSCRIPTION_ID and ARM_SUBSCRIPTION_ID when given. */
  subscriptionId?: string;
  /** The OIDC token's audience. Default `api://AzureADTokenExchange`. */
  audience?: string;
  /** The Entra authority host, for an emulator. Default `https://login.microsoftonline.com`. */
  authority?: string;
  /**
   * Also trade for a database token (#4572): a second client credentials
   * grant per identity, for {@link AZURE_DATABASE_SCOPE}, set as
   * {@link AZURE_DATABASE_TOKEN_ENV}. The sql lexicon's `entra` token source
   * signs in to Azure Database for PostgreSQL with it. Default false.
   */
  database?: boolean;
  rules: CloudIdentityRule[];
}

/**
 * Pulumi Cloud (#4549). The rules' identities name the access token traded
 * for: `team:<name>` (a team token), `user:<login>` (a personal token),
 * `organization` or `organization:admin` (an organization token). The
 * organization's OIDC issuer policies decide which a forge token may get.
 */
export interface PulumiCloudIdentity {
  /** The Pulumi organization. */
  organization: string;
  /** The OIDC token's audience. Default `urn:pulumi:org:<organization>`. */
  audience?: string;
  /** The Pulumi Cloud API, for a self-hosted one or a fake. Default `https://api.pulumi.com`; when set, the trade sets PULUMI_BACKEND_URL to it too. */
  apiUrl?: string;
  rules: CloudIdentityRule[];
}

/** `ci.identity.cloud` as the declaration holds it. */
export interface CloudIdentityDeclaration {
  aws?: AwsCloudIdentity;
  gcp?: GcpCloudIdentity;
  azure?: AzureCloudIdentity;
  pulumi?: PulumiCloudIdentity;
}

/**
 * What one job trades for, per cloud: the job's own identity and where to
 * trade it, and with `targets` (#4332) the identities of the targets that
 * take another, first match wins. A cloud names its own identity, or
 * targets, or both.
 */
export interface CloudTradeSpec {
  aws?: { role?: string; targets?: Array<{ targets: string[]; role: string }>; region: string; audience: string; endpoint?: string };
  gcp?: { serviceAccount?: string; targets?: Array<{ targets: string[]; serviceAccount: string }>; provider: string; audience: string; stsEndpoint?: string; iamEndpoint?: string };
  azure?: { clientId?: string; targets?: Array<{ targets: string[]; clientId: string }>; tenantId: string; audience: string; subscriptionId?: string; authority?: string; database?: boolean };
  /** Pulumi Cloud (#4549): `token` is the identity, such as `team:deployers`. */
  pulumi?: { token?: string; targets?: Array<{ targets: string[]; token: string }>; organization: string; audience: string; apiUrl?: string };
}

/** The key a cloud's trade names its identity under. */
export const IDENTITY_KEY = { aws: "role", gcp: "serviceAccount", azure: "clientId", pulumi: "token" } as const;

/** A pipeline's two trades: the plan and record jobs', and the apply jobs'. */
export interface PipelineCloudIdentity {
  plan: CloudTradeSpec;
  apply: CloudTradeSpec;
}

/**
 * A glob over a name (#4296): `*` and `?` within the name, `[...]` classes,
 * `{a,b}` alternatives, a leading `!` negates. The grammar `ciMemberGlobs`
 * documents, with no dependency, so this module bundles small (#4332).
 */
export function nameGlobMatch(glob: string, name: string): boolean {
  if (glob.startsWith("!")) return !nameGlobMatch(glob.slice(1), name);
  return expandBraces(glob).some((g) => new RegExp(`^${globBody(g, false)}$`).test(name));
}

/**
 * A glob over a target (#4332): `*` within one `/` segment, `**` across
 * segments (and `a/**\/b` across none), `?` one character. The reading of
 * `targetGlobMatch` in ./op/gate-quorum.ts and the terraform lexicon's unit
 * globs, so a root's glob means one thing in each.
 */
export function targetGlobMatch(glob: string, target: string): boolean {
  const trim = (v: string): string => v.replace(/\\/g, "/").replace(/\/+$/, "");
  return new RegExp(`^${globBody(trim(glob), true)}$`).test(trim(target));
}

/** `{a,b}` alternatives, nested too, expanded into plain globs. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  let depth = 0;
  const cuts: number[] = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const parts = cuts.length === 0 ? [glob.slice(open + 1, i)] : [open, ...cuts].map((at, k, all) => glob.slice(at + 1, k + 1 < all.length ? all[k + 1] : i));
      const rest = expandBraces(glob.slice(i + 1));
      return parts.flatMap((p) => expandBraces(glob.slice(0, open) + p)).flatMap((head) => rest.map((tail) => head + tail));
    } else if (c === "," && depth === 1) cuts.push(i);
  }
  return [glob];
}

/** A glob's regular expression body. `paths`: `**` crosses `/`, and classes and braces are literal. */
function globBody(g: string, paths: boolean): string {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*" && paths) {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
      while (g[i + 1] === "*") i++;
    } else if (c === "?") re += "[^/]";
    else if (c === "[" && !paths && g.indexOf("]", i + 2) > i) {
      const end = g.indexOf("]", i + 2);
      const body = g.slice(i + 1, end);
      re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`.replace(/\\/g, "\\\\");
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

const matches = (globs: readonly string[] | undefined, name: string | undefined): boolean => globs === undefined || (name !== undefined && globs.some((g) => nameGlobMatch(g, name)));

/** One target's names: a string, or the several names a tool knows it by, such as a Terraform root's key and its directory. */
export type TargetNames = string | readonly string[];

const coversTarget = (r: CloudIdentityRule, target: TargetNames | undefined): boolean =>
  r.targets === undefined || (target !== undefined && (typeof target === "string" ? [target] : target).some((n) => r.targets!.some((g) => targetGlobMatch(g, n))));

/**
 * The first rule that covers `env`, `member` and `target`, or undefined.
 * With no `target`, the first rule that names no targets: the pipeline's own.
 * A `target` given as several names is covered by a rule when any one name
 * matches a glob, and the first rule in declared order wins, whichever name
 * it matched.
 */
export function ruleFor(rules: readonly CloudIdentityRule[], env: string, member?: string, target?: TargetNames): CloudIdentityRule | undefined {
  return rules.find((r) => matches(r.environments, env) && matches(r.members, member) && coversTarget(r, target));
}

/** The provider's resource name without the `//iam.googleapis.com/` prefix. */
const providerPath = (p: string): string => p.replace(/^(https:)?\/\/iam\.googleapis\.com\//, "");

/** Where each cloud trades, the same for every identity of the cloud. */
function cloudPlace(decl: CloudIdentityDeclaration, cloud: IdentityCloud): Record<string, string | boolean> {
  if (cloud === "aws") {
    const a = decl.aws!;
    return { region: a.region ?? "us-east-1", audience: a.audience ?? "sts.amazonaws.com", ...(a.endpoint ? { endpoint: a.endpoint } : {}) };
  }
  if (cloud === "gcp") {
    const g = decl.gcp!;
    const provider = providerPath(g.provider);
    return {
      provider,
      audience: g.audience ?? `https://iam.googleapis.com/${provider}`,
      ...(g.stsEndpoint ? { stsEndpoint: g.stsEndpoint } : {}),
      ...(g.iamEndpoint ? { iamEndpoint: g.iamEndpoint } : {}),
    };
  }
  if (cloud === "pulumi") {
    const p = decl.pulumi!;
    return { organization: p.organization, audience: p.audience ?? pulumiAudience(p.organization), ...(p.apiUrl ? { apiUrl: p.apiUrl } : {}) };
  }
  const z = decl.azure!;
  return {
    tenantId: z.tenantId,
    audience: z.audience ?? "api://AzureADTokenExchange",
    ...(z.subscriptionId ? { subscriptionId: z.subscriptionId } : {}),
    ...(z.authority ? { authority: z.authority } : {}),
    ...(z.database ? { database: true } : {}),
  };
}

/** One cloud's trade: its own identity, the targets that take another, and where it trades. */
function cloudTrade(decl: CloudIdentityDeclaration, cloud: IdentityCloud, own: string | undefined, targets: Array<{ targets: string[]; id: string }>): Record<string, unknown> {
  const key = IDENTITY_KEY[cloud];
  return {
    ...(own !== undefined ? { [key]: own } : {}),
    ...(targets.length > 0 ? { targets: targets.map((t) => ({ targets: [...t.targets], [key]: t.id })) } : {}),
    ...cloudPlace(decl, cloud),
  };
}

/**
 * The plan and apply trades of the pipeline for `env` and `member`, or
 * undefined when no rule of any cloud covers them. A cloud no rule covers
 * is left out of both. Each cloud's own identity is the first rule with no
 * `targets` that covers the pipeline; the rules with `targets` before it
 * are the cloud's `targets` (#4332), so the plan trade holds every plan
 * identity a target of the member takes, and the apply trade every apply
 * identity.
 */
export function resolveCloudIdentity(decl: CloudIdentityDeclaration | undefined, env: string, member?: string): PipelineCloudIdentity | undefined {
  if (!decl) return undefined;
  const plan: Record<string, unknown> = {};
  const apply: Record<string, unknown> = {};
  for (const cloud of IDENTITY_CLOUDS) {
    const rules = decl[cloud]?.rules;
    if (!rules) continue;
    const covering = rules.filter((r) => matches(r.environments, env) && matches(r.members, member));
    const cut = covering.findIndex((r) => r.targets === undefined);
    const own = cut < 0 ? undefined : covering[cut];
    const byTarget = (cut < 0 ? covering : covering.slice(0, cut)).filter((r) => r.targets !== undefined);
    if (!own && byTarget.length === 0) continue;
    plan[cloud] = cloudTrade(decl, cloud, own?.plan, byTarget.map((r) => ({ targets: r.targets!, id: r.plan })));
    apply[cloud] = cloudTrade(decl, cloud, own?.apply, byTarget.map((r) => ({ targets: r.targets!, id: r.apply })));
  }
  return Object.keys(plan).length > 0 ? { plan: plan as CloudTradeSpec, apply: apply as CloudTradeSpec } : undefined;
}

/**
 * The plan and apply trades of one target (#4332): per cloud, the first
 * rule that covers `env`, `member` and `target`. Undefined when no rule of
 * any cloud covers it. Each trade names one identity per cloud and no
 * `targets`.
 */
export function resolveTargetCloudIdentity(decl: CloudIdentityDeclaration | undefined, env: string, member: string | undefined, target: TargetNames): PipelineCloudIdentity | undefined {
  if (!decl) return undefined;
  const plan: Record<string, unknown> = {};
  const apply: Record<string, unknown> = {};
  for (const cloud of IDENTITY_CLOUDS) {
    const rule = decl[cloud] && ruleFor(decl[cloud]!.rules, env, member, target);
    if (!rule) continue;
    plan[cloud] = cloudTrade(decl, cloud, rule.plan, []);
    apply[cloud] = cloudTrade(decl, cloud, rule.apply, []);
  }
  return Object.keys(plan).length > 0 ? { plan: plan as CloudTradeSpec, apply: apply as CloudTradeSpec } : undefined;
}

/** The name a pull request environment's rule is matched against (#4330): any pull request's, as `pr-*` covers it. */
export const PR_ENV_IDENTITY_PROBE = "pr-1";

/**
 * The trade a pull request environment's jobs take (#4330): per cloud, the
 * apply identity of the rules {@link resolveCloudIdentity} gives `pr-1` and
 * `member`, from the rules that name `environments` only. env-up runs the
 * change's code with that identity, so a rule with no `environments`, which
 * covers every environment, is never one it gets: give pull request
 * environments a rule of their own, such as `environments: ["pr-*"]`, whose
 * identity reaches only what they may touch. Undefined when no such rule
 * covers them.
 */
export function resolvePrEnvCloudIdentity(decl: CloudIdentityDeclaration | undefined, member?: string): CloudTradeSpec | undefined {
  if (!decl) return undefined;
  const named: CloudIdentityDeclaration = {};
  for (const cloud of IDENTITY_CLOUDS) {
    const c = decl[cloud];
    if (c) (named as Record<string, unknown>)[cloud] = { ...c, rules: c.rules.filter((r) => r.environments !== undefined) };
  }
  return resolveCloudIdentity(named, PR_ENV_IDENTITY_PROBE, member)?.apply;
}

/** One apply job's targets (#4332): those that take the same identities, per cloud. */
export interface CloudIdentityGroup {
  /** A job-name-safe name: the first rule with `targets` they took (its `name`, or one from its first glob), else `default`. */
  name: string;
  /** The group's targets, in the order given. */
  targets: string[];
  /** Their plan and apply trades, one identity per cloud. Undefined when no rule covers them. */
  identity?: PipelineCloudIdentity;
}

/** The group name a glob gives: `envs/prod/**` is `envs-prod`. terragucci's `nameFrom` (groups.ts at INTENTIUS/terragucci ca05bd9). */
const nameFrom = (glob: string): string => glob.toLowerCase().replace(/\*+/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

/** The name of the apply job group for {@link CloudIdentityGroup}s with no rule of their own. */
export const DEFAULT_IDENTITY_GROUP = "default";

/**
 * `targets` grouped by the identities they take (#4332), so each group's
 * apply runs in a job of its own with its group's identities alone.
 * Targets that take the same plan and apply identity in every cloud are one
 * group. The groups come in the order their first target comes, with
 * `default` (the targets no rule with `targets` took) last. Names are
 * unique: a second group of one name gets `-2`.
 */
export function cloudIdentityGroups(decl: CloudIdentityDeclaration | undefined, env: string, member: string | undefined, targets: readonly string[]): CloudIdentityGroup[] {
  const byKey = new Map<string, { base: string; group: CloudIdentityGroup }>();
  for (const target of targets) {
    const identity = resolveTargetCloudIdentity(decl, env, member, target);
    const key = JSON.stringify(identity ? IDENTITY_CLOUDS.map((c) => [identity.plan[c] ? tradeIdentities({ [c]: identity.plan[c] }) : [], identity.apply[c] ? tradeIdentities({ [c]: identity.apply[c] }) : []]) : null);
    const at = byKey.get(key);
    if (at) {
      at.group.targets.push(target);
      continue;
    }
    const rule = IDENTITY_CLOUDS.map((c) => decl?.[c] && ruleFor(decl[c]!.rules, env, member, target)).find((r) => r?.targets !== undefined);
    const named = rule ? (rule.name ?? (nameFrom(rule.targets![0]!) || "group")) : DEFAULT_IDENTITY_GROUP;
    // An Op wave's own jobs are `decide` and `share-<i>` (./op/op-waves.ts), so a group takes neither name.
    const base = named === "decide" || /^share-\d+$/.test(named) ? `${named}-targets` : named;
    byKey.set(key, { base, group: { name: base, targets: [target], ...(identity ? { identity } : {}) } });
  }
  const all = [...byKey.values()];
  const ordered = [...all.filter((g) => g.base !== DEFAULT_IDENTITY_GROUP), ...all.filter((g) => g.base === DEFAULT_IDENTITY_GROUP)];
  const taken = new Set<string>();
  return ordered.map(({ base, group }) => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    return { ...group, name };
  });
}

/**
 * An Op wave's cloud identities over its run targets (#4332), as
 * `OpWave.cloud` and `OpWave.jobs` (./op/op-waves.ts) take them. With two
 * or more {@link cloudIdentityGroups}, the deciding job trades for every
 * plan identity of the targets and each group's job for its group's apply
 * identities alone. With one group, the wave's one job trades for that
 * group's apply identities, and `jobs` is absent. Neither, when no rule
 * covers a target.
 */
export function cloudIdentityWave(
  decl: CloudIdentityDeclaration | undefined,
  env: string,
  member: string | undefined,
  targets: readonly string[],
): { cloud?: CloudTradeSpec; jobs?: Array<{ name: string; runs: string[]; cloud?: CloudTradeSpec }> } {
  const groups = cloudIdentityGroups(decl, env, member, targets);
  if (groups.length === 0) return {};
  if (groups.length === 1) return groups[0]!.identity ? { cloud: groups[0]!.identity.apply } : {};
  const plan = resolveCloudIdentity(decl, env, member)?.plan;
  return {
    ...(plan ? { cloud: plan } : {}),
    jobs: groups.map((g) => ({ name: g.name, runs: [...g.targets], ...(g.identity ? { cloud: g.identity.apply } : {}) })),
  };
}

/**
 * Why one job may not apply under `spec` (#4332), or undefined: a cloud
 * whose trade names more than one identity would hand one job the apply
 * tokens of targets that apply as different identities.
 */
export function oneApplyIdentityProblem(spec: CloudTradeSpec): string | undefined {
  for (const cloud of tradedClouds(spec)) {
    const ids = tradeIdentities({ [cloud]: spec[cloud] });
    if (ids.length > 1) return `ci.identity.cloud gives the targets of one apply job ${ids.length} ${cloud} apply identities (${ids.join(", ")}); a job may hold one, so apply them in a job per identity (cloudIdentityGroups)`;
  }
  return undefined;
}

/** The clouds a trade covers, in {@link IDENTITY_CLOUDS} order. */
export function tradedClouds(spec: CloudTradeSpec): IdentityCloud[] {
  return IDENTITY_CLOUDS.filter((c) => spec[c] !== undefined);
}

/** Every identity a trade names, once each: the roles, the service accounts, the client ids, its targets' too (#4332). */
export function tradeIdentities(spec: CloudTradeSpec): string[] {
  const out: string[] = [];
  for (const cloud of tradedClouds(spec)) {
    const c = spec[cloud] as Record<string, unknown> & { targets?: Array<Record<string, string>> };
    const key = IDENTITY_KEY[cloud];
    for (const id of [c[key] as string | undefined, ...(c.targets ?? []).map((t) => t[key])]) if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The problems of a declared `ci.identity.cloud`, each with its JSON
 * pointer: a rule whose plan and apply are one identity, or a plan identity
 * that is another rule's apply identity. Either would let the plan job,
 * which runs the change's code, act as an apply identity.
 */
export function cloudIdentityProblems(decl: CloudIdentityDeclaration): Array<{ pointer: string; message: string }> {
  const out: Array<{ pointer: string; message: string }> = [];
  for (const cloud of IDENTITY_CLOUDS) {
    const rules = decl[cloud]?.rules ?? [];
    const applies = new Set(rules.map((r) => r.apply));
    rules.forEach((r, i) => {
      const pointer = `/ci/identity/cloud/${cloud}/rules/${i}`;
      if (r.plan === r.apply) out.push({ pointer, message: `ci.identity.cloud.${cloud}.rules[${i}] plans and applies as ${r.plan}; the plan runs the pull request's code, so give it an identity of its own` });
      else if (applies.has(r.plan)) out.push({ pointer, message: `ci.identity.cloud.${cloud}.rules[${i}] plans as ${r.plan}, which another rule applies as; the plan runs the pull request's code, so give it an identity no rule applies as` });
      if (cloud === "pulumi") {
        for (const side of ["plan", "apply"] as const) {
          if (!pulumiTokenRequest(r[side])) out.push({ pointer: `${pointer}/${side}`, message: `ci.identity.cloud.pulumi.rules[${i}].${side} is ${JSON.stringify(r[side])}; a Pulumi Cloud identity is team:<name>, user:<login>, organization or organization:admin` });
        }
      }
    });
  }
  return out;
}

/** The OIDC audience Pulumi Cloud's token exchange takes for `organization` (#4549). */
export function pulumiAudience(organization: string): string {
  return `urn:pulumi:org:${organization}`;
}

/**
 * The token a Pulumi Cloud identity asks the exchange for (#4549): its
 * `requested_token_type` and `scope`, or undefined when `identity` is none
 * of `team:<name>`, `user:<login>`, `organization`, `organization:admin`.
 * The trade script reads identities the same way.
 */
export function pulumiTokenRequest(identity: string): { tokenType: string; scope?: string } | undefined {
  const m = /^(team|user):([^\s:]+)$/.exec(identity);
  if (m) return { tokenType: `urn:pulumi:token-type:access_token:${m[1] === "team" ? "team" : "personal"}`, scope: identity };
  if (identity === "organization") return { tokenType: "urn:pulumi:token-type:access_token:organization" };
  if (identity === "organization:admin") return { tokenType: "urn:pulumi:token-type:access_token:organization", scope: "admin" };
  return undefined;
}

/** The variable the trade step reads its {@link CloudTradeSpec} from, as JSON. */
export const TRADE_SPEC_ENV = "CHANT_CLOUD_TRADE";

/** The GitLab `id_tokens` variable a cloud's token comes in: `CHANT_ID_TOKEN_AWS`, `_GCP`, `_AZURE`, `_PULUMI`. */
export function idTokenVar(cloud: IdentityCloud): string {
  return `CHANT_ID_TOKEN_${cloud.toUpperCase()}`;
}

/**
 * The variables a GitHub or Forgejo step requests an OIDC token with, and
 * the GitLab `id_tokens` variables the trade reads. A step that runs the
 * change's code starts without them, once the trade is done.
 */
export const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", ...IDENTITY_CLOUDS.map(idTokenVar), TRADE_SPEC_ENV] as const;

/** The variables the trade sets, per cloud. */
export const TRADED_VARS: Record<IdentityCloud, readonly string[]> = {
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"],
  gcp: ["GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN"],
  azure: ["AZURE_ACCESS_TOKEN", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "ARM_CLIENT_ID", "ARM_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "ARM_SUBSCRIPTION_ID", AZURE_DATABASE_TOKEN_ENV],
  pulumi: ["PULUMI_ACCESS_TOKEN", "PULUMI_BACKEND_URL"],
};

/**
 * How the trade leaves what it got. `github-env`: `NAME=value` lines
 * appended to the file argv 1 names (`$GITHUB_ENV`), and an `::add-mask::`
 * line for each secret, so every later step of the job has them. `sh`: a
 * file of `export` lines a GitLab script sources, mode 0600.
 */
export type TradeFormat = "github-env" | "sh";

/**
 * The variable the trade sets when a cloud names `targets` (#4332): the
 * path of a JSON file, mode 0600 and outside the checkout, with each
 * identity's credentials and which targets take it. {@link targetCloudEnv}
 * reads it.
 */
export const CLOUD_TARGETS_ENV = "CHANT_CLOUD_TARGETS";

/** The file {@link CLOUD_TARGETS_ENV} names: per cloud, the job's own identity, the targets that take another, and each identity's variables. */
export interface CloudTargetsFile {
  version: 1;
  clouds: Partial<Record<IdentityCloud, { default?: string; targets: Array<{ targets: string[]; identity: string }>; vars: Record<string, Record<string, string>> }>>;
}

/**
 * The trade, a script for `node -e` with no dependency, so it runs before
 * the checkout and reads none of the change's files. argv 1 is the file it
 * writes and argv 2 its {@link TradeFormat}; {@link TRADE_SPEC_ENV} is the
 * spec. The token comes from a cloud's {@link idTokenVar} when the job has
 * it (GitLab's `id_tokens`), else from the forge's request URL with the
 * cloud's audience, once per cloud. Each identity of a cloud (its own, and
 * its targets', #4332) is traded with that one token. The job's own
 * identity's variables go in the file; with targets, every identity's go in
 * the {@link CLOUD_TARGETS_ENV} file too. A value that holds anything but
 * printable ASCII with no space is refused, so no answer can add a line of
 * its own to the file. The script never prints a token.
 */
export const TRADE_JS = [
  'const fs=require("fs");',
  "const [out,format]=process.argv.slice(1);",
  "const Q=String.fromCharCode(39);",
  'const fail=(m)=>{console.error("chant: the OIDC trade failed: "+m);process.exit(1)};',
  `let spec;try{spec=JSON.parse(process.env.${TRADE_SPEC_ENV}||"")}catch{fail("${TRADE_SPEC_ENV} is not JSON")}`,
  'const clean=(v)=>typeof v==="string"&&/^[\\x21-\\x7e]+$/.test(v);',
  'const trim=(u)=>String(u).replace(/\\/+$/,"");',
  'const post=async(url,headers,body)=>{const r=await fetch(url,{method:"POST",headers,body});const t=await r.text();if(!r.ok)throw new Error(url+" answered "+r.status+": "+t.slice(0,200).replace(/\\s+/g," "));return t};',
  'const json=(t,what)=>{try{return JSON.parse(t)}catch{throw new Error(what+" answered with no JSON")}};',
  "const idToken=async(cloud,aud)=>{",
  'const named=process.env["CHANT_ID_TOKEN_"+cloud.toUpperCase()];if(named)return named;',
  "const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;",
  'if(!u||!k)throw new Error("the job can request no OIDC token for "+cloud+": it needs id-token: write, and a pull request from a fork gets none");',
  'const r=await fetch(u+(u.includes("?")?"&":"?")+"audience="+encodeURIComponent(aud),{headers:{authorization:"bearer "+k,accept:"application/json"}});',
  'if(!r.ok)throw new Error("the OIDC token request answered "+r.status);',
  'const v=json(await r.text(),"the OIDC token request").value;if(!clean(v))throw new Error("the OIDC token request gave no token");return v};',
  `const KEY=${JSON.stringify(IDENTITY_KEY)};`,
  // #4332: a cloud's identities, its own first, then its targets', once each.
  'const ids=(c)=>{const s=spec[c],l=[];if(s[KEY[c]])l.push(s[KEY[c]]);for(const t of s.targets||[])if(!l.includes(t[KEY[c]]))l.push(t[KEY[c]]);if(!l.length)throw new Error(c+" names no identity");return l};',
  "const vars={},secrets=[],said=[],by={};",
  "const run=async()=>{",
  'if(spec.aws){const a=spec.aws;const tok=await idToken("aws",a.audience);by.aws={};',
  'const ep=trim(a.endpoint||process.env.AWS_ENDPOINT_URL_STS||("https://sts."+a.region+".amazonaws.com"+(a.region.startsWith("cn-")?".cn":"")));',
  'for(const role of ids("aws")){',
  'const t=await post(ep+"/",{"content-type":"application/x-www-form-urlencoded",accept:"application/xml"},new URLSearchParams({Action:"AssumeRoleWithWebIdentity",Version:"2011-06-15",RoleArn:role,RoleSessionName:"chant-"+(process.env.GITHUB_RUN_ID||process.env.CI_JOB_ID||"job"),WebIdentityToken:tok}).toString());',
  'const g=(k)=>{const m=new RegExp("<"+k+">([^<]+)</"+k+">").exec(t);return m?m[1].trim():undefined};',
  'const id=g("AccessKeyId"),key=g("SecretAccessKey"),st=g("SessionToken");if(!clean(id)||!clean(key)||!clean(st))throw new Error("STS gave no credentials for "+role);',
  "by.aws[role]={AWS_ACCESS_KEY_ID:id,AWS_SECRET_ACCESS_KEY:key,AWS_SESSION_TOKEN:st,AWS_REGION:a.region,AWS_DEFAULT_REGION:a.region};secrets.push(key,st);said.push(role)}",
  "if(a.role)Object.assign(vars,by.aws[a.role])}",
  'if(spec.gcp){const c=spec.gcp;const tok=await idToken("gcp",c.audience);by.gcp={};',
  'const sts=trim(c.stsEndpoint||"https://sts.googleapis.com"),iam=trim(c.iamEndpoint||"https://iamcredentials.googleapis.com");',
  'const fed=json(await post(sts+"/v1/token",{"content-type":"application/json"},JSON.stringify({grantType:"urn:ietf:params:oauth:grant-type:token-exchange",audience:"//iam.googleapis.com/"+c.provider,scope:"https://www.googleapis.com/auth/cloud-platform",requestedTokenType:"urn:ietf:params:oauth:token-type:access_token",subjectToken:tok,subjectTokenType:"urn:ietf:params:oauth:token-type:jwt"})),"Google STS").access_token;',
  'if(!clean(fed))throw new Error("Google STS gave no token");',
  'for(const sa of ids("gcp")){',
  'const at=json(await post(iam+"/v1/projects/-/serviceAccounts/"+encodeURIComponent(sa)+":generateAccessToken",{"content-type":"application/json",authorization:"Bearer "+fed},JSON.stringify({scope:["https://www.googleapis.com/auth/cloud-platform"]})),"IAM credentials").accessToken;',
  'if(!clean(at))throw new Error("IAM credentials gave no token for "+sa);',
  "by.gcp[sa]={GOOGLE_OAUTH_ACCESS_TOKEN:at,CLOUDSDK_AUTH_ACCESS_TOKEN:at};secrets.push(at);said.push(sa)}",
  "if(c.serviceAccount)Object.assign(vars,by.gcp[c.serviceAccount])}",
  'if(spec.azure){const z=spec.azure;const tok=await idToken("azure",z.audience);by.azure={};',
  'const host=trim(z.authority||"https://login.microsoftonline.com");',
  'for(const cid of ids("azure")){',
  'const at=json(await post(host+"/"+encodeURIComponent(z.tenantId)+"/oauth2/v2.0/token",{"content-type":"application/x-www-form-urlencoded"},new URLSearchParams({client_id:cid,scope:"https://management.azure.com/.default",grant_type:"client_credentials",client_assertion_type:"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",client_assertion:tok}).toString()),"Entra").access_token;',
  'if(!clean(at))throw new Error("Entra gave no token for "+cid);',
  // #4572: with azure.database, a second grant for Azure Database for PostgreSQL's scope.
  `let db;if(z.database){db=json(await post(host+"/"+encodeURIComponent(z.tenantId)+"/oauth2/v2.0/token",{"content-type":"application/x-www-form-urlencoded"},new URLSearchParams({client_id:cid,scope:${JSON.stringify(AZURE_DATABASE_SCOPE)},grant_type:"client_credentials",client_assertion_type:"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",client_assertion:tok}).toString()),"Entra").access_token;if(!clean(db))throw new Error("Entra gave no database token for "+cid);secrets.push(db)}`,
  `by.azure[cid]={AZURE_ACCESS_TOKEN:at,AZURE_CLIENT_ID:cid,AZURE_TENANT_ID:z.tenantId,ARM_CLIENT_ID:cid,ARM_TENANT_ID:z.tenantId,...(z.subscriptionId?{AZURE_SUBSCRIPTION_ID:z.subscriptionId,ARM_SUBSCRIPTION_ID:z.subscriptionId}:{}),...(db?{${AZURE_DATABASE_TOKEN_ENV}:db}:{})};secrets.push(at);said.push(cid)}`,
  "if(z.clientId)Object.assign(vars,by.azure[z.clientId])}",
  // #4549: Pulumi Cloud's OAuth token exchange, one access token per identity (pulumiTokenRequest).
  'if(spec.pulumi){const p=spec.pulumi;const tok=await idToken("pulumi",p.audience);by.pulumi={};',
  'const api=trim(p.apiUrl||"https://api.pulumi.com");',
  'for(const id of ids("pulumi")){',
  'const m=/^(team|user):([^\\s:]+)$/.exec(id),org=id==="organization"||id==="organization:admin";if(!m&&!org)throw new Error("Pulumi Cloud has no token for "+id);',
  'const f={audience:"urn:pulumi:org:"+p.organization,grant_type:"urn:ietf:params:oauth:grant-type:token-exchange",subject_token_type:"urn:ietf:params:oauth:token-type:id_token",requested_token_type:"urn:pulumi:token-type:access_token:"+(m?(m[1]==="team"?"team":"personal"):"organization"),subject_token:tok};',
  'if(m)f.scope=id;else if(id==="organization:admin")f.scope="admin";',
  'const at=json(await post(api+"/api/oauth/token",{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},new URLSearchParams(f).toString()),"Pulumi Cloud").access_token;',
  'if(!clean(at))throw new Error("Pulumi Cloud gave no token for "+id);',
  'by.pulumi[id]={PULUMI_ACCESS_TOKEN:at,...(p.apiUrl?{PULUMI_BACKEND_URL:api}:{})};secrets.push(at);said.push("Pulumi Cloud "+id)}',
  "if(p.token)Object.assign(vars,by.pulumi[p.token])}",
  // #4332: with targets, every identity's variables go in a file of their own, outside the checkout.
  'const clouds=Object.keys(by);if(clouds.some((c)=>(spec[c].targets||[]).length>0)){',
  'const doc={version:1,clouds:{}};for(const c of clouds){const s=spec[c];doc.clouds[c]={...(s[KEY[c]]?{default:s[KEY[c]]}:{}),targets:(s.targets||[]).map((t)=>({targets:t.targets,identity:t[KEY[c]]})),vars:by[c]}}',
  'const tf=trim(process.env.RUNNER_TEMP||process.env.TMPDIR||"/tmp")+"/chant-cloud-targets-"+require("crypto").randomBytes(8).toString("hex")+".json";',
  `fs.writeFileSync(tf,JSON.stringify(doc),{mode:0o600,flag:"wx"});vars.${CLOUD_TARGETS_ENV}=tf}`,
  'for(const [k,v] of Object.entries(vars))if(!clean(v))throw new Error(k+" is not a value the job can hold");',
  'if(format==="github-env"){for(const s of secrets)console.log("::add-mask::"+s);fs.appendFileSync(out,Object.entries(vars).map(([k,v])=>k+"="+v+"\\n").join(""))}',
  'else fs.writeFileSync(out,Object.entries(vars).map(([k,v])=>"export "+k+"="+Q+v.split(Q).join(Q+"\\\\"+Q+Q)+Q+"\\n").join(""),{mode:0o600});',
  'for(const s of said)console.error("chant: traded the job\\u0027s OIDC token for "+s)};',
  "run().catch((e)=>fail(e&&e.message?e.message:String(e)));",
].join("");

/**
 * The shell line of a trade step: `node -e` from `/`, so no file of the
 * checkout (a `package.json`, an `.npmrc`) is in reach, writing `out` in
 * `format`.
 */
export function tradeLine(out: string, format: TradeFormat): string {
  return `(cd / && node -e '${TRADE_JS}' "${out}" ${format})`;
}

/** The GitLab file the trade writes and the plan script sources, outside the project directory. */
export const GITLAB_TRADE_FILE = "${TMPDIR:-/tmp}/chant-cloud-$CI_JOB_ID.sh";

/**
 * The lines a GitLab job's script starts with when it trades: the trade,
 * the unset of the token variables (and, with `extraUnset`, the forge
 * tokens'), and the source of what the trade wrote, which it then deletes.
 */
export function gitlabTradeLines(extraUnset: readonly string[] = []): string[] {
  return [
    tradeLine(GITLAB_TRADE_FILE, "sh"),
    `unset ${[...extraUnset, ...OIDC_REQUEST_VARS].join(" ")}`,
    `. "${GITLAB_TRADE_FILE}" && rm -f "${GITLAB_TRADE_FILE}"`,
  ];
}

/** GitLab's `id_tokens:` for a trade: one per cloud, with the cloud's audience. */
export function gitlabTradeIdTokens(spec: CloudTradeSpec): Record<string, { aud: string }> {
  return Object.fromEntries(tradedClouds(spec).map((c) => [idTokenVar(c), { aud: spec[c]!.audience }]));
}

/**
 * `env` for one target's tool (#4332): the job's environment with each
 * cloud's credentials replaced by those of the identity `target` takes, as
 * the trade left them in the {@link CLOUD_TARGETS_ENV} file. A target that
 * no rule with `targets` covers keeps the job's own identity. Without the
 * file (no cloud names targets), `env` as it is. terragucci's `rootRoleEnv`
 * (roles.ts at INTENTIUS/terragucci ca05bd9).
 */
export function targetCloudEnv(env: Readonly<Record<string, string | undefined>>, target: string, read: (path: string) => string = (p) => readFileSync(p, "utf-8")): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const path = env[CLOUD_TARGETS_ENV];
  if (!path) return out;
  const file = readTargetsFile(path, read);
  for (const cloud of IDENTITY_CLOUDS) {
    const c = file.clouds[cloud];
    if (!c) continue;
    const id = targetIdentityIn(c, target);
    if (id === undefined || id === c.default) continue;
    const vars = c.vars[id];
    if (!vars) throw new Error(`${CLOUD_TARGETS_ENV} (${path}) holds no ${cloud} credentials for ${id}`);
    for (const k of TRADED_VARS[cloud]) delete out[k];
    Object.assign(out, vars);
  }
  return out;
}

/**
 * The identity `target` takes in one cloud of a {@link CloudTargetsFile}:
 * the first entry whose globs match, else the job's own. Undefined when
 * the job has none for that cloud.
 */
export function targetIdentityIn(cloud: { default?: string; targets: Array<{ targets: string[]; identity: string }> }, target: string): string | undefined {
  return cloud.targets.find((t) => t.targets.some((g) => targetGlobMatch(g, target)))?.identity ?? cloud.default;
}

/** The {@link CloudTargetsFile} at `path`, refused when it is not one. */
export function readTargetsFile(path: string, read: (path: string) => string = (p) => readFileSync(p, "utf-8")): CloudTargetsFile {
  let file: CloudTargetsFile;
  try {
    file = JSON.parse(read(path)) as CloudTargetsFile;
  } catch (err) {
    throw new Error(`${CLOUD_TARGETS_ENV} names ${path}, which cannot be read as the trade's targets file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!file || file.version !== 1 || typeof file.clouds !== "object" || file.clouds === null) throw new Error(`${CLOUD_TARGETS_ENV} names ${path}, which is not a version 1 targets file`);
  return file;
}
