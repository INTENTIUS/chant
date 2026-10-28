/**
 * An environment per open pull request (#4298): `ci.prEnvironment` in the
 * workspace declaration names a template environment, and each open pull
 * request gets `pr-<number>`, derived from it.
 *
 *   chant components pr-env up --base <ref> --pr <n>
 *       From the pull request's job. Plans the components the change reaches
 *       into `pr-<n>` and applies them once an approval stands for that plan
 *       (`chant approve pr-<n> pr-env --plan <digest>`). The environment
 *       takes the template's declared endpoint unless a `pr-*` entry declares
 *       its own. Every resource it creates carries the ownership marker
 *       `{ stack, env: "pr-<n>" }`, since the build parameter that
 *       `ownership.env` reads is set to the environment's name. The record
 *       of the apply goes to `_pr-envs/records.jsonl` on chant/lifecycle.
 *   chant components pr-env down --pr <n> [--reason closed|expired]
 *       From the job a closed pull request starts. Tears down what carries
 *       the marker the record names, and nothing else (the ownership check,
 *       {@link teardownRefusal} and {@link ownedEntries}).
 *   chant components pr-env sweep
 *       From a schedule. Tears down each live environment whose TTL passed,
 *       or whose pull request the forge says is closed or merged. GitLab
 *       starts no pipeline when a merge request closes, so there the sweep is
 *       how a closed merge request loses its environment.
 *
 * The settings are read from the declaration at base, never from the pull
 * request, so a change cannot name another template or a longer TTL.
 *
 * A pull request's environment is not a release target (ws-104, ws-105):
 * releases come from green commits, and `components promote` refuses to
 * promote to or from one ({@link releaseTargetRefusal}). Its record says
 * `releaseTarget: false`.
 *
 * terragucci's `ephemeral.ts` gives each copy a suffixed Terraform state key.
 * That part is Terraform's own and stays there; chant keys ownership on the
 * marker its lexicons stamp and read back (`../lifecycle/teardown.ts`). A
 * product supplies the rest as adapters (#4330): its plan and apply
 * (`./pr-env-run.ts`), and a teardown for what no lexicon tears down
 * ({@link PrEnvTeardownAdapter}), which reads the marker back from the copy
 * as a lexicon does.
 */

import type { ChantConfig } from "../config";
import { CHANT_EXIT } from "../exit-codes";
import { environmentEndpoint, environmentName, isEnvironmentPattern, isOwnershipParamRef, matchesDeclaredEnvironment, resolveOwnershipStack, type EnvironmentDeclaration } from "../config-environments";
import type { OwnershipMarker } from "../ownership";
import { executeTeardown, planTeardown, type TeardownPlan, type TeardownPlanEntry, type TeardownReport } from "../lifecycle/teardown";
import type { ObservationLexicon, TeardownCandidate, TeardownEnumeration, TeardownExecution } from "../lexicon";
import { applyLiveEndpoint } from "../live-endpoint";
import type { ComponentEnvironmentDeclaration } from "./component";

/** The gate a pull request's environment waits on, under the pull request's op `pr-<n>`. */
export const PR_ENV_GATE = "pr-env";

/** Where the records live on chant/lifecycle, under the member's ledger prefix. */
export const PR_ENV_LEDGER_DIR = "_pr-envs";
export const PR_ENV_LEDGER_FILE = "records.jsonl";

/** Where `pr-env` writes its report and note unless `--output` says. */
export { PR_ENV_REPORT_DIR } from "./pr-pipeline";

/** The file `pr-env up --no-push` writes its record to under `--output`, for `pr-env post` (#4295). */
export const PR_ENV_RECORD_FILE = "pr-env-record.json";

/** The commit status context the up and down jobs set. */
export const PR_ENV_STATUS_CONTEXT = "chant/pr-env";

/**
 * What joins a component's locations when it has more than one copy
 * (#4609): a component with two `pulumi-up` steps has two review stacks,
 * kept on the record as one string under the component's name.
 */
export const PR_ENV_LOCATION_SEPARATOR = ", ";

/** The variable a component's build reads the template's name from. */
export const PR_ENV_TEMPLATE_VAR = "CHANT_ENV_TEMPLATE";

/** Exit codes, from the table (#4553): done, failed or refused, waiting on an approval, and rows another run holds (#4594). */
export const PR_ENV_EXIT = { done: CHANT_EXIT.done, failed: CHANT_EXIT.failed, waiting: CHANT_EXIT.waiting, held: CHANT_EXIT.held } as const;

/** The environment of pull request `pr`. */
export function prEnvironmentName(pr: number): string {
  return `pr-${pr}`;
}

const PR_ENV_NAME = /^pr-[1-9][0-9]*$/;

/** Whether `name` is a pull request's environment name, `pr-<n>`. */
export function isPrEnvironmentName(name: string): boolean {
  return PR_ENV_NAME.test(name);
}

/** The hidden line that marks the environment's note on the pull request. */
export function prEnvNoteMarker(env: string, member?: string): string {
  return member ? `<!-- chant-pr-env:${env}:${member} -->` : `<!-- chant-pr-env:${env} -->`;
}

/** The status context, per member in a workspace. */
export function prEnvStatusContext(member?: string): string {
  return member ? `${PR_ENV_STATUS_CONTEXT}/${member}` : PR_ENV_STATUS_CONTEXT;
}

/** The approve command for an environment's plan. */
export function prEnvApproveCommand(op: string, digest: string, approver = "<you>"): string {
  return `chant approve ${op} ${PR_ENV_GATE} --plan ${digest} --approver ${approver} --sign`;
}

/**
 * Why `env` cannot be a release's source or target, or undefined when it
 * can. A pull request's environment never is (ws-104: releases come from
 * green commits).
 */
export function releaseTargetRefusal(env: string): string | undefined {
  if (!isPrEnvironmentName(env)) return undefined;
  return `${env} is a pull request's environment (ci.prEnvironment), which is never a release target: releases come from green commits (ws-104), and pr-env down removes it when the pull request closes`;
}

/** A TTL of the form `90m`, `72h` or `7d`, in milliseconds. Undefined for any other form. */
export function ttlMs(ttl: string): number | undefined {
  const m = /^([1-9][0-9]*)(m|h|d)$/.exec(ttl);
  if (!m) return undefined;
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(m[1]) * unit;
}

// ── deriving the environment ───────────────────────────────────────────────

/** What `pr-env up` derives from the template and the project's config, or why it cannot. */
export type PrEnvDerivation =
  | {
      env: string;
      template: string;
      stack: string;
      /** The build parameter `ownership.env` reads, set to `env` for the build. */
      param: string;
      /** The config's environments with `env` declared outright, carrying the template's endpoint when it has none of its own. */
      environments: EnvironmentDeclaration[] | undefined;
      /** The endpoint the environment's plans and applies use, if any. */
      endpoint?: string;
      /** The lexicon whose own stack the template names (#4609), when it is not a chant.config.ts environment. */
      templateOwner?: string;
    }
  | { refusal: string };

/**
 * A lexicon that takes `ci.prEnvironment.template` as one of its own stacks
 * (#4609): the pulumi lexicon takes `<project>/<stack>`, so plywood's
 * `review_stacks.template` needs no chant.config.ts environment of that name.
 * `describe` says which stack, for the log line.
 */
export interface PrEnvTemplateOwner {
  lexicon: string;
  describe: string;
}

/** The first lexicon among `plugins` that takes `template` as its own stack (`prEnvTemplate`), or undefined. */
export function prEnvTemplateOwner(plugins: ReadonlyArray<{ name: string; prEnvTemplate?(template: string): string | undefined }> | undefined, template: string): PrEnvTemplateOwner | undefined {
  for (const p of plugins ?? []) {
    const describe = p.prEnvTemplate?.(template);
    if (describe) return { lexicon: p.name, describe };
  }
  return undefined;
}

/**
 * Derive pull request `pr`'s environment from `template` and the project's
 * config. Refused when the resources it creates could not be told apart
 * from the template's: marking is off, or `ownership.env` is a literal (every
 * resource would carry that literal) or unset. Refused too when the config
 * would not take the name, or does not declare the template. A template a
 * lexicon takes as its own stack (`opts.templateOwner`, #4609) needs no
 * declared environment of that name, and carries no endpoint of its own.
 */
export function derivePrEnvironment(config: ChantConfig, template: string, pr: number, opts: { templateOwner?: PrEnvTemplateOwner } = {}): PrEnvDerivation {
  const env = prEnvironmentName(pr);
  const stack = resolveOwnershipStack(config);
  if (stack === undefined) {
    return { refusal: `${env}: the project declares no ownership.stack, so nothing it creates would carry a marker, and pr-env down could not tell its resources from any other; set ownership: { stack: "<name>", env: { param: "env" } } in chant.config.ts` };
  }
  const own = config.ownership?.env;
  if (!isOwnershipParamRef(own)) {
    return {
      refusal: own === undefined
        ? `${env}: ownership.env is unset, so the marker would name no environment and pr-env down could not select ${env}'s resources; set ownership.env to { param: "env" }`
        : `${env}: ownership.env is the literal ${JSON.stringify(own)}, so ${env}'s resources would carry ${JSON.stringify(own)}'s marker; set ownership.env to { param: "env" } so the marker follows the environment`,
    };
  }
  if (!config.buildParams?.[own.param]) {
    return { refusal: `${env}: ownership.env reads build parameter "${own.param}", which chant.config.ts's buildParams does not declare` };
  }
  const declared = config.environments;
  if (declared && declared.length > 0) {
    if (!opts.templateOwner && !declared.some((e) => environmentName(e) === template)) {
      return { refusal: `${env}: ci.prEnvironment.template is ${template}, which chant.config.ts's environments do not declare` };
    }
    if (!matchesDeclaredEnvironment(declared, env)) {
      return { refusal: `${env}: chant.config.ts's environments do not cover ${env}; add "pr-*" to environments` };
    }
    // A literal pr-<n> is a declared environment of its own, maybe one a release targets.
    if (declared.some((e) => environmentName(e) === env)) {
      return { refusal: `${env} is declared outright in chant.config.ts's environments, so it is not a pull request's to create or tear down; declare "pr-*" instead` };
    }
  }
  const endpoint = environmentEndpoint(declared, env) ?? (opts.templateOwner ? undefined : environmentEndpoint(declared, template));
  const environments = declared ? [endpoint ? { name: env, endpoint } : env, ...declared] : undefined;
  return { env, template, stack, param: own.param, environments, ...(endpoint ? { endpoint } : {}), ...(opts.templateOwner ? { templateOwner: opts.templateOwner.lexicon } : {}) };
}

/** The placeholder a template's site URL or domain names the environment with (#4330). */
export const PR_ENV_SITE_PLACEHOLDER = "{env}";

/**
 * A component's site in `env`, a pull request's environment, carried over
 * from its site in `template` (#4330). An entry the component declares for
 * `env` itself wins. Otherwise the template's runtime and lifecycle remote
 * carry over as they are. Its URL and domain carry over only when they name
 * the environment with `{env}`, which becomes `pr-<n>`: a literal URL or
 * domain is the template's own release, so it is left out rather than
 * pointing pr-<n> at it. Undefined when neither is declared.
 */
export function prEnvironmentSite(declared: readonly ComponentEnvironmentDeclaration[] | undefined, template: string, env: string): ComponentEnvironmentDeclaration | undefined {
  const own = declared?.find((d) => d.name === env);
  if (own) return { ...own };
  const from = declared?.find((d) => d.name === template);
  if (!from) return undefined;
  const named = (v: string | undefined): string | undefined => (v && v.includes(PR_ENV_SITE_PLACEHOLDER) ? v.split(PR_ENV_SITE_PLACEHOLDER).join(env) : undefined);
  const url = named(from.url);
  const domain = named(from.domain);
  return {
    name: env,
    ...(from.runtime ? { runtime: from.runtime } : {}),
    ...(url ? { url } : {}),
    ...(domain ? { domain } : {}),
    ...(from.lifecycle ? { lifecycle: from.lifecycle } : {}),
  };
}

// ── records ────────────────────────────────────────────────────────────────

/** One line of `_pr-envs/records.jsonl`: an apply, or a teardown. */
export interface PrEnvRecord {
  version: 1;
  kind: "up" | "down";
  pr: number;
  /** `pr-<n>`. */
  env: string;
  /** The workspace member whose environment it is, when in one. */
  member?: string;
  /** The template environment it was derived from. */
  template: string;
  /** The marker every resource of the environment carries. What teardown selects on. */
  marker: { stack: string; env: string };
  /** The commit applied, or the commit the teardown ran at. */
  commit: string;
  /** The components applied (up) or the lexicons torn down (down). */
  components: string[];
  /**
   * Up (#4330): where each component's copy lives, by component, as the
   * adapter that applied it says (a Terraform root's suffixed state key).
   * A teardown adapter reads it back from the live environment.
   */
  locations?: Record<string, string>;
  /** The change-set digest applied; empty for a teardown. */
  planDigest: string;
  /** `incomplete`: a teardown that left something, so the environment stays live and the sweep tries again. */
  result: "applied" | "failed" | "destroyed" | "incomplete";
  by: string;
  timestamp: string;
  /** Up: when the sweep tears it down unless another apply comes first. */
  expiresAt?: string;
  approvedBy?: string[];
  /** Down: why. */
  reason?: "closed" | "expired";
  /** Down: the teardown's outcome counts. */
  outcomes?: { deleted: number; failed: number; retained: number; notPrunable: number; skipped: number; holes: number };
  /** Always false: a pull request's environment is never a release target. */
  releaseTarget: false;
  runUrl?: string;
}

/** The records of a records.jsonl text, oldest first. Malformed lines are skipped. */
export function parsePrEnvRecords(text: string | null | undefined): PrEnvRecord[] {
  const out: PrEnvRecord[] = [];
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as PrEnvRecord;
      if (r.version === 1 && (r.kind === "up" || r.kind === "down") && typeof r.pr === "number" && typeof r.env === "string" && r.marker && typeof r.marker.stack === "string") out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

/** A pull request's environment as its records say it stands. */
export interface LivePrEnvironment {
  pr: number;
  env: string;
  member?: string;
  template: string;
  marker: { stack: string; env: string };
  /** The commit last applied. */
  commit: string;
  /** Every component an apply of it ever touched. */
  components: string[];
  /** Where each component's copy lives, merged over every up (#4330). */
  locations?: Record<string, string>;
  applied: string;
  expiresAt: string;
  /** Its last teardown left something, so the sweep tries again. */
  teardownIncomplete?: boolean;
}

/**
 * The environments that stand, by name, from the records in order: an up
 * (applied or failed part way) makes or refreshes one, a down that
 * destroyed everything ends it, and any other down leaves it live.
 */
export function livePrEnvironments(records: readonly PrEnvRecord[]): Map<string, LivePrEnvironment> {
  const live = new Map<string, LivePrEnvironment>();
  for (const r of records) {
    if (r.kind === "up") {
      const was = live.get(r.env);
      const locations = { ...(was?.locations ?? {}), ...(r.locations ?? {}) };
      live.set(r.env, {
        pr: r.pr,
        env: r.env,
        ...(r.member ? { member: r.member } : {}),
        template: r.template,
        marker: { ...r.marker },
        commit: r.commit,
        components: [...new Set([...(was?.components ?? []), ...r.components])],
        ...(Object.keys(locations).length > 0 ? { locations } : {}),
        applied: r.timestamp,
        expiresAt: r.expiresAt ?? r.timestamp,
      });
    } else if (r.result === "destroyed") {
      live.delete(r.env);
    } else {
      const was = live.get(r.env);
      if (was) live.set(r.env, { ...was, teardownIncomplete: true });
    }
  }
  return live;
}

/** Whether a live environment's TTL passed at `now`. */
export function expired(env: Pick<LivePrEnvironment, "expiresAt">, now: Date): boolean {
  return Date.parse(env.expiresAt) <= now.getTime();
}

// ── the ownership check ────────────────────────────────────────────────────

/**
 * Why pull request `pr`'s environment must not be torn down as `live`
 * says, or undefined when it may. The record must name `pr-<n>` for this
 * pull request, its marker's env must be that name, and the config must not
 * declare the name outright (a declared environment belongs to the project,
 * not to a pull request).
 */
export function teardownRefusal(pr: number, live: LivePrEnvironment, declared: EnvironmentDeclaration[] | undefined): string | undefined {
  const env = prEnvironmentName(pr);
  if (live.env !== env || live.pr !== pr) return `the record for ${live.env} names pull request ${live.pr}, not ${pr}, so pr-env down --pr ${pr} does not tear it down`;
  if (!isPrEnvironmentName(live.marker.env) || live.marker.env !== env) {
    return `the record for ${env} names the marker env ${JSON.stringify(live.marker.env)}, which is not ${env}, so its teardown would select another environment's resources; nothing was torn down`;
  }
  const literal = (declared ?? []).find((e) => !isEnvironmentPattern(environmentName(e)) && environmentName(e) === env);
  if (literal) return `${env} is declared outright in chant.config.ts's environments, so it is not a pull request's to tear down; nothing was torn down`;
  return undefined;
}

/**
 * The entries of a teardown plan the environment owns: those whose marker
 * is exactly `marker`. `planTeardown` already selects on the marker; this
 * is the second check, so a lexicon that returned another's resources cannot
 * widen what pr-env down deletes. `dropped` counts what was left out.
 */
export function ownedEntries(plan: TeardownPlan, marker: OwnershipMarker): { plan: TeardownPlan; dropped: TeardownPlanEntry[] } {
  const owns = (e: TeardownPlanEntry) => e.marker?.stack === marker.stack && e.marker?.env === marker.env;
  return { plan: { ...plan, entries: plan.entries.filter(owns) }, dropped: plan.entries.filter((e) => !owns(e)) };
}

/**
 * A teardown a product supplies for what no lexicon tears down (#4330), such
 * as a Terraform root's copy under a suffixed state key: chant has no
 * Terraform runner, so terragucci supplies this. It takes part in the same
 * two halves a lexicon's teardown does (`../lifecycle/teardown.ts`): `owned`
 * names what the environment owns, each with the marker read back from it,
 * and `teardown` deletes the candidates chant hands back. Every candidate
 * whose marker is not exactly `{ stack, env: "pr-<n>" }` is dropped before
 * `teardown` sees it, and a candidate it says nothing about counts as failed.
 */
export interface PrEnvTeardownAdapter {
  /** The name outcomes are attributed to, as a lexicon's are. */
  name: string;
  /**
   * The lexicons this adapter tears down in place of (`terraform`). Their own
   * teardown is left out, so a lexicon with no teardown execution does not
   * leave the environment incomplete when the adapter covers it.
   */
  lexicons?: string[];
  /** What the environment owns: candidates with their read-back markers, and what could not be read. */
  owned(input: PrEnvTeardownAdapterInput): Promise<TeardownEnumeration>;
  /** Delete the candidates: one outcome per candidate, keyed by name. */
  teardown(input: PrEnvTeardownAdapterInput & { candidates: TeardownCandidate[] }): Promise<TeardownExecution>;
}

/** What a {@link PrEnvTeardownAdapter} is told about the environment. */
export interface PrEnvTeardownAdapterInput {
  /** `pr-<n>`. */
  environment: string;
  /** The marker everything is selected on. */
  marker: OwnershipMarker;
  /** The environment as its records say it stands: the commit last applied, its components and their locations. */
  live: LivePrEnvironment;
}

/** An adapter in the shape `planTeardown` and `executeTeardown` call: a lexicon with only its two teardown halves. */
function adapterLexicon(adapter: PrEnvTeardownAdapter, live: LivePrEnvironment): ObservationLexicon {
  const shaped: Pick<ObservationLexicon, "name" | "teardownOwned" | "executeTeardown"> = {
    name: adapter.name,
    teardownOwned: (o) => adapter.owned({ environment: o.environment, marker: o.marker, live }),
    executeTeardown: (o) => adapter.teardown({ environment: o.environment, marker: o.marker, live, candidates: o.candidates }),
  };
  return shaped as ObservationLexicon;
}

/** What {@link tearDownPrEnvironment} needs. */
export interface PrEnvTeardownInput {
  pr: number;
  live: LivePrEnvironment;
  /** The project's config, for its environments and stacks. Absent: a product with no chant.config.ts, whose adapters do the teardown. */
  config?: ChantConfig;
  /** The lexicons whose teardown runs. Default none. */
  plugins?: ObservationLexicon[];
  /** Teardowns a product supplies (#4330), run after the lexicons'. */
  adapters?: PrEnvTeardownAdapter[];
  warn?: (message: string) => void;
}

/**
 * Tear down pull request `pr`'s environment with the ownership check: refused
 * before any read when {@link teardownRefusal} says so; otherwise the live
 * resources under the record's marker are planned, every entry whose marker
 * is not exactly `{ stack, env: "pr-<n>" }` is dropped ({@link ownedEntries}),
 * and only the rest go to each lexicon's or adapter's teardown. The endpoint
 * is the one the environment was applied at: its own `pr-*` entry's, else the
 * template's. A lexicon an adapter covers (`lexicons`) is left out.
 */
export async function tearDownPrEnvironment(input: PrEnvTeardownInput): Promise<{ refusal: string } | { report: TeardownReport; dropped: number; marker: { stack: string; env: string } }> {
  const { pr, live } = input;
  const config = input.config ?? {};
  const refusal = teardownRefusal(pr, live, config.environments);
  if (refusal) return { refusal };
  const adapters = input.adapters ?? [];
  const covered = new Set(adapters.flatMap((a) => a.lexicons ?? []));
  const names = new Set<string>();
  for (const a of adapters) {
    if (names.has(a.name)) return { refusal: `two teardown adapters are named ${a.name}, so their outcomes could not be told apart; nothing was torn down` };
    names.add(a.name);
  }
  const lexicons = (input.plugins ?? []).filter((x) => !covered.has(x.name));
  if (lexicons.some((x) => names.has(x.name))) return { refusal: `a teardown adapter shares its name with a lexicon (${[...names].filter((n) => lexicons.some((x) => x.name === n)).join(", ")}), so their outcomes could not be told apart; nothing was torn down` };
  const env = prEnvironmentName(pr);
  const marker = { stack: live.marker.stack, env };
  const endpoint = environmentEndpoint(config.environments, env) ?? environmentEndpoint(config.environments, live.template);
  const applied = applyLiveEndpoint(endpoint ? [{ name: env, endpoint }] : [], env, lexicons.filter((x) => x.teardownOwned || x.describeResources || x.executeTeardown));
  if (applied.notice) input.warn?.(applied.notice);
  const plugins = [...lexicons, ...adapters.map((a) => adapterLexicon(a, live))];
  const deployedStacks = (config.stacks ?? []).map((s) => ({ name: s.name, ...(s.region ? { region: s.region } : {}) }));
  try {
    const planned = await planTeardown({ environment: env, stack: marker.stack, plugins, ...(deployedStacks.length > 0 ? { deployedStacks } : {}) });
    const owned = ownedEntries(planned, marker);
    const report = await executeTeardown({ environment: env, stack: marker.stack, plugins, plan: owned.plan, ...(deployedStacks.length > 0 ? { deployedStacks } : {}) });
    return { report, dropped: owned.dropped.length, marker };
  } finally {
    applied.restore();
  }
}

/** A teardown report's counts for the record. */
export function teardownCounts(report: TeardownReport): NonNullable<PrEnvRecord["outcomes"]> {
  const n = (o: string) => report.outcomes.filter((x) => x.outcome === o).length;
  return { deleted: n("deleted"), failed: n("failed"), retained: n("retained"), notPrunable: n("not-prunable"), skipped: n("skipped"), holes: report.plan.holes.length };
}

/**
 * Whether a teardown left the environment clean: nothing failed, nothing was
 * skipped for a lexicon with no teardown execution, and the plan had no
 * holes. A retained resource (a lexicon's deliberate keep) does not count
 * against it.
 */
export function teardownComplete(report: TeardownReport): boolean {
  const c = teardownCounts(report);
  return c.failed === 0 && c.skipped === 0 && c.holes === 0;
}

// ── the handover (#4295) ─────────────────────────────────────────────────────

/** What {@link acceptHandedRecord} checks a handed-on record against: the job's own values and the settings at its commit. */
export interface HandedRecordCheck {
  pr: number;
  member?: string;
  /** The commit the up job checked out, from the forge, not from the record. */
  head: string;
  /** `ci.prEnvironment` at the commit the post job runs at. */
  template: string;
  ttlMs: number;
  now: Date;
  by: string;
  runUrl?: string;
}

/**
 * The record `pr-env up --no-push` handed on, checked as data: the up job ran
 * the change's code, so what it wrote is the change's. It must be an `up`
 * line for this pull request's `pr-<n>`, with that marker env, the template
 * the base declares, and string components. The commit, the actor, the run
 * and the expiry are the post job's own, so a change cannot keep its
 * environment past the TTL its base set. Refused otherwise, and kept nowhere.
 */
export function acceptHandedRecord(raw: unknown, check: HandedRecordCheck): { record: PrEnvRecord } | { refusal: string } {
  const env = prEnvironmentName(check.pr);
  const [r] = parsePrEnvRecords(typeof raw === "object" && raw !== null ? JSON.stringify(raw) : "");
  if (!r) return { refusal: "The env-up job handed on a record that does not read, so it was not kept." };
  const why =
    r.kind !== "up" ? `is a ${r.kind} record`
    : r.pr !== check.pr || r.env !== env ? `names ${r.env} of pull request ${r.pr}, not ${env}`
    : r.marker.env !== env ? `names the marker env ${JSON.stringify(r.marker.env)}, not ${env}`
    : r.template !== check.template ? `names the template ${r.template}, and the base declares ${check.template}`
    : (r.member ?? undefined) !== check.member ? `names the member ${r.member ?? "(none)"}`
    : !Array.isArray(r.components) || r.components.some((c) => typeof c !== "string") ? "lists components that are not names"
    : r.result !== "applied" && r.result !== "failed" ? `has the result ${r.result}`
    : undefined;
  if (why) return { refusal: `The env-up job handed on a record that ${why}, so it was not kept.` };
  return {
    record: {
      version: 1,
      kind: "up",
      pr: check.pr,
      env,
      ...(check.member ? { member: check.member } : {}),
      template: check.template,
      marker: { stack: r.marker.stack, env },
      commit: check.head,
      components: [...r.components],
      ...(handedLocations(r.locations) ? { locations: handedLocations(r.locations)! } : {}),
      planDigest: typeof r.planDigest === "string" ? r.planDigest : "",
      result: r.result,
      by: check.by,
      timestamp: check.now.toISOString(),
      expiresAt: new Date(check.now.getTime() + check.ttlMs).toISOString(),
      ...(Array.isArray(r.approvedBy) ? { approvedBy: r.approvedBy.filter((a): a is string => typeof a === "string") } : {}),
      releaseTarget: false,
      ...(check.runUrl ? { runUrl: check.runUrl } : {}),
    },
  };
}

/** A handed-on report row's site, kept only as its three strings. */
function handedSite(raw: unknown): PrEnvReportRow["site"] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const site = Object.fromEntries((["runtime", "url", "domain"] as const).filter((k) => typeof r[k] === "string").map((k) => [k, r[k] as string]));
  return Object.keys(site).length > 0 ? site : undefined;
}

/** A handed-on record's locations, kept only as a map of strings to strings. */
function handedLocations(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The report `pr-env up` handed on, checked as data before the post job
 * renders a note from it: an `up` report for this pull request's `pr-<n>`.
 * Its head is the post job's own.
 */
export function handedPrEnvReport(raw: unknown, check: { pr: number; head: string; member?: string }): { report: PrEnvReport } | { refusal: string } {
  const env = prEnvironmentName(check.pr);
  if (typeof raw !== "object" || raw === null) return { refusal: "The env-up job handed on no report." };
  const r = raw as Partial<PrEnvReport>;
  if (r.stage !== "up" || r.pr !== check.pr || r.env !== env) return { refusal: `The env-up job handed on a report that is not ${env}'s.` };
  const statuses: PrEnvReport["status"][] = ["applied", "nothing", "waiting", "changed", "plan-failed", "failed", "refused"];
  if (!r.status || !statuses.includes(r.status)) return { refusal: "The env-up job handed on a report with no status it could have." };
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    report: {
      stage: "up",
      pr: check.pr,
      env,
      ...(check.member ? { member: check.member } : {}),
      template: str(r.template),
      head: check.head,
      op: check.member ? `pr-${check.pr}-${check.member}` : `pr-${check.pr}`,
      gate: PR_ENV_GATE,
      digest: str(r.digest),
      status: r.status,
      ...(typeof r.message === "string" ? { message: r.message } : {}),
      ...(typeof r.endpoint === "string" ? { endpoint: r.endpoint } : {}),
      components: (Array.isArray(r.components) ? r.components : []).map((c) => ({
        component: str(c?.component),
        status: str(c?.status),
        create: num(c?.create),
        update: num(c?.update),
        replace: num(c?.replace),
        delete: num(c?.delete),
        ...(typeof c?.location === "string" ? { location: c.location } : {}),
        ...(handedSite(c?.site) ? { site: handedSite(c?.site)! } : {}),
      })),
      ...(Array.isArray(r.approvedBy) ? { approvedBy: r.approvedBy.filter((a): a is string => typeof a === "string") } : {}),
    },
  };
}

// ── the note ───────────────────────────────────────────────────────────────

/** One component's row in the report and the note. */
export interface PrEnvReportRow {
  component: string;
  status: string;
  create: number;
  update: number;
  replace: number;
  delete: number;
  /** Where its copy lives, as the adapter says (#4330). */
  location?: string;
  /** Its site in pr-<n>: the runtime, URL and domain carried over from the template's (#4330, {@link prEnvironmentSite}). */
  site?: { runtime?: string; url?: string; domain?: string };
}

/** What one `pr-env up` or `down` run came to, as `pr-env.json` holds it. */
export interface PrEnvReport {
  stage: "up" | "down";
  pr: number;
  env: string;
  member?: string;
  template: string;
  head: string;
  op: string;
  gate: string;
  digest: string;
  status: "applied" | "nothing" | "waiting" | "changed" | "plan-failed" | "failed" | "refused" | "destroyed" | "incomplete" | "absent";
  message?: string;
  endpoint?: string;
  components: PrEnvReportRow[];
  approvedBy?: string[];
  expiresAt?: string;
  outcomes?: PrEnvRecord["outcomes"];
}

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/** The environment's note on the pull request: one per environment, updated in place. */
export function renderPrEnvNote(r: PrEnvReport, approver = "<you>"): string {
  const out = [prEnvNoteMarker(r.env, r.member), `### chant pull request environment ${code(r.env)}${r.member ? ` in member ${code(r.member)}` : ""}`, ""];
  const from = `derived from ${code(r.template)}${r.endpoint ? ` at ${code(r.endpoint)}` : ""}`;
  switch (r.status) {
    case "applied":
      out.push(`Applied ${r.components.length} component${r.components.length === 1 ? "" : "s"} at ${code(r.head.slice(0, 12))}, ${from}. It expires ${r.expiresAt ?? "?"}, and closing the pull request tears it down before then.`);
      break;
    case "nothing":
      out.push(`Nothing this change touches is deployed by a component, so ${code(r.env)} gets nothing.`);
      break;
    case "waiting":
    case "changed":
      out.push(r.status === "changed" ? `An approval stands for another plan of ${code(r.env)}; the plan changed since, so nothing applied.` : `Planned ${code(r.env)}, ${from}. It waits for an approval of its plan; nothing applied.`);
      out.push("", "A reviewer who read the plan approves it with:", "", "```", prEnvApproveCommand(r.op, r.digest, approver), "```", "", "Then run the job again, or push to the pull request.");
      break;
    case "destroyed":
      out.push(`Torn down: ${r.outcomes?.deleted ?? 0} resource${r.outcomes?.deleted === 1 ? "" : "s"} carrying the marker of ${code(r.env)} deleted.`);
      break;
    case "incomplete":
      out.push(`The teardown of ${code(r.env)} left something (${r.outcomes?.failed ?? 0} failed, ${r.outcomes?.skipped ?? 0} skipped, ${r.outcomes?.holes ?? 0} unread). It stays live, and the next sweep tries again.`);
      break;
    case "absent":
      out.push(`${code(r.env)} has no live record, so there is nothing to tear down.`);
      break;
    default:
      out.push(`The ${r.stage} of ${code(r.env)} ${r.status === "plan-failed" ? "failed to plan" : r.status === "refused" ? "was refused" : "failed"}.`);
  }
  if (r.message) out.push("", `> ${r.message.split("\n").join("\n> ")}`);
  if (r.components.length > 0) {
    // #4330: a Where column when a row has a URL or a location, as code: env-up ran the change's code, so the post job does not link it.
    const at = (c: PrEnvReportRow): string | undefined => c.site?.url ?? c.site?.domain ?? c.location;
    const where = r.components.some((c) => at(c));
    out.push("", `| Component | Status | Create | Update | Replace | Delete |${where ? " Where |" : ""}`, `|---|---|---:|---:|---:|---:|${where ? "---|" : ""}`);
    for (const c of r.components) out.push(`| ${code(c.component)} | ${c.status} | ${c.create} | ${c.update} | ${c.replace} | ${c.delete} |${where ? ` ${at(c) ? code(at(c)!) : ""} |` : ""}`);
  }
  if (r.digest) out.push("", `Plan digest: ${code(r.digest)}${r.approvedBy?.length ? `, approved by ${r.approvedBy.map(code).join(", ")}` : ""}`);
  out.push("", `${code(r.env)} is not a release target: releases come from green commits.`);
  return out.join("\n") + "\n";
}

/** The commit status a report sets: success, failure, or pending while it waits on an approval. */
export function prEnvStatusState(r: Pick<PrEnvReport, "status">): "success" | "failure" | "pending" {
  if (r.status === "waiting") return "pending";
  return r.status === "applied" || r.status === "nothing" || r.status === "destroyed" || r.status === "absent" ? "success" : "failure";
}

/** A commit status description, at most 140 characters. */
export function prEnvStatusDescription(r: PrEnvReport): string {
  const what: Record<PrEnvReport["status"], string> = {
    applied: `${r.env} applied, expires ${r.expiresAt ?? "?"}`,
    nothing: `${r.env}: nothing to deploy`,
    waiting: `${r.env} waits for an approval of its plan`,
    changed: `${r.env}: the plan changed after its approval`,
    "plan-failed": `${r.env}: a component failed to plan`,
    failed: `${r.env}: the ${r.stage} failed`,
    refused: `${r.env}: refused`,
    destroyed: `${r.env} torn down`,
    incomplete: `${r.env}: the teardown left something; the sweep tries again`,
    absent: `${r.env}: nothing to tear down`,
  };
  const text = what[r.status];
  return text.length > 140 ? text.slice(0, 137) + "..." : text;
}
