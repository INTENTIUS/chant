/**
 * The environments a member's components may deploy to, for `chant workspace
 * graph --composites` (#2695), so a reader such as hud can offer staging or
 * prod beside the default without guessing a name.
 *
 * Each environment comes from one of three places, and says which:
 *
 * - `config`: a name the member's `chant.config.ts` declares in
 *   `environments`. A pattern such as `pr-*` names no environment by itself
 *   and is not listed, but it legalizes the ledger's `pr-42`.
 * - `ledger`: an environment with a release ledger for the member on
 *   `chant/lifecycle` (`_members/<member>/<env>/releases.jsonl`, or the flat
 *   `<env>/releases.jsonl`, read the way `workspace status` reads it).
 * - `builtin`: `local`, which `chant run --components` uses without `--env`
 *   (`../cli/handlers/run.ts`), when neither the config nor the ledger names
 *   it.
 *
 * A component may also declare environments of its own (#3153, ws-095),
 * each with the site a release goes to there: the runtime that hosts it, its
 * URL, a custom domain and the git remote its lifecycle records are pushed
 * to. Each declared environment the member already lists carries that site,
 * and one it doesn't is added with source `component` when `chant run --env`
 * would take it, or left out with `environments-component-undeclared` when
 * the config's environments don't cover it.
 *
 * `chant run --env` refuses a name the config's `environments` doesn't cover
 * whenever it declares any (`unknownEnvError` in `../env.ts`), so a ledger
 * environment the config no longer covers is left out, with a reason. The
 * default is `local`: `chant.config.ts` has no default environment, and
 * `chant run` without `--env` deploys to `local` even when the config's
 * `environments` leaves it out.
 *
 * The config is the one `runtimes.ts` loads, in the working tree or the tree
 * `--at` exported. The ledger is always the local `chant/lifecycle` branch,
 * as for `workspace status`, and is never fetched.
 */

import { execFileSync } from "node:child_process";
import { environmentName, isEnvironmentPattern, matchesDeclaredEnvironment, type EnvironmentDeclaration } from "../config";
import type { ComponentEnvironmentDeclaration } from "../components/component";
import type { ReasonCode } from "./reason-codes";
import { LOCAL_RUNTIME, type MemberRuntimes } from "./runtimes";
import { ENV_PATTERN, LIFECYCLE_REF, MEMBERS_DIR } from "./status";

/** The environment `chant run --components` deploys to without `--env`. */
export const LOCAL_ENVIRONMENT = "local";

/** Why a member's environments are only `local`, or leave out one the ledger has. Closed: part of the read contract. */
export const ENVIRONMENT_REASON_CODES = [
  /** The member's chant.config.ts could not be read: the same read and the same code as its runtimes. */
  "runtimes-config-unreadable",
  /** The config declares no environments, so only local and the ledger's environments are listed. */
  "environments-none-declared",
  /** The ledger has releases in an environment the config's environments no longer cover, so chant run --env would refuse it. */
  "environments-ledger-undeclared",
  /** The chant/lifecycle branch exists and the member's ledger directories could not be listed. */
  "environments-ledger-unreadable",
  /** A component declares an environment the config's environments don't cover, so chant run --env would refuse it (#3153). */
  "environments-component-undeclared",
] as const satisfies readonly ReasonCode[];
export type EnvironmentReasonCode = (typeof ENVIRONMENT_REASON_CODES)[number];

export interface EnvironmentReason {
  code: EnvironmentReasonCode;
  message: string;
}

/** One environment a component may deploy to. */
export interface ComponentEnvironment {
  /** What `--env` takes. */
  name: string;
  /** True for the environment `chant run --components` deploys to without `--env`. */
  default: boolean;
  /** Where the name came from; the first of config, ledger, builtin and the component's own environments that names it. */
  source: "config" | "ledger" | "builtin" | "component";
  /** Where a release of the component goes in this environment, as the component declares it (#3153), or null when it declares nothing for it. */
  site: ComponentSite | null;
  /** The command that deploys the component there, on the site's runtime when the member hosts it and else the default runtime, run in the member's directory. */
  command: string;
}

/** A component's declared site in one environment (#3153): every field present, null when not declared. */
export interface ComponentSite {
  runtime: string | null;
  url: string | null;
  domain: string | null;
  lifecycle: string | null;
}

/** The environments a member's ledger has, or why they couldn't be listed. */
export interface LedgerEnvironments {
  envs: string[];
  reason: EnvironmentReason | null;
}

/** Lists one member's ledger environments; git unless a test swaps it. */
export type LedgerEnvironmentReader = (member: { name: string; dir: string }, cwd: string) => LedgerEnvironments;

/** What one member's config and ledger say about environments. */
export interface MemberEnvironments {
  /** Each environment in list order, without the per-component site and command. */
  environments: Omit<ComponentEnvironment, "command" | "site">[];
  reasons: EnvironmentReason[];
  /** The config's environments, for whether `chant run --env` takes a name: null when the config couldn't be read, `[]` when it declares none. */
  declared?: EnvironmentDeclaration[] | null;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
}

function exists(cwd: string, spec: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", spec]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The environments with a release ledger for `member` on the local
 * `chant/lifecycle` branch: the directories under `_members/<member>/` when it
 * exists (the root member never has one), else the flat layout's top-level
 * directories, that hold a `releases.jsonl`.
 */
export const readLedgerEnvironments: LedgerEnvironmentReader = (member, cwd) => {
  if (!exists(cwd, `refs/heads/${LIFECYCLE_REF}`)) return { envs: [], reason: null };
  const own = member.dir !== "." && exists(cwd, `refs/heads/${LIFECYCLE_REF}:${MEMBERS_DIR}/${member.name}`);
  const base = own ? `${MEMBERS_DIR}/${member.name}/` : "";
  try {
    const dirs = git(cwd, ["ls-tree", "--full-tree", `refs/heads/${LIFECYCLE_REF}:${base}`])
      .split("\n")
      .map((line) => line.match(/^\d+ tree [0-9a-f]+\t(.+)$/)?.[1])
      .filter((name): name is string => !!name && ENV_PATTERN.test(name));
    if (dirs.length === 0) return { envs: [], reason: null };
    const checked = git(cwd, ["cat-file", "--batch-check"], dirs.map((d) => `refs/heads/${LIFECYCLE_REF}:${base}${d}/releases.jsonl\n`).join(""))
      .split("\n")
      .filter(Boolean);
    return { envs: dirs.filter((_, i) => checked[i] !== undefined && !checked[i].endsWith(" missing")).sort(), reason: null };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    return { envs: [], reason: { code: "environments-ledger-unreadable", message: `${LIFECYCLE_REF}:${base || "."}: ${message}` } };
  }
};

/** Join a member's config and ledger into its environment list, `local` first, then config order, then the ledger's. */
export function memberEnvironments(runtimes: MemberRuntimes | undefined, ledger: LedgerEnvironments | undefined): MemberEnvironments {
  const reasons: EnvironmentReason[] = [];
  const declared = runtimes?.environments ?? null;
  if (runtimes && declared === null) {
    const unreadable = runtimes.reasons.find((r) => r.code === "runtimes-config-unreadable");
    reasons.push({ code: "runtimes-config-unreadable", message: unreadable?.message ?? "chant.config.ts could not be read" });
  } else if (declared && declared.length === 0) {
    reasons.push({ code: "environments-none-declared", message: "chant.config.ts declares no environments, so only local and the environments in the ledger are listed" });
  }
  if (ledger?.reason) reasons.push(ledger.reason);

  const literals = (declared ?? []).map(environmentName).filter((n) => !isEnvironmentPattern(n));
  const ledgerEnvs = ledger?.envs ?? [];
  const covered = (env: string): boolean => !declared || declared.length === 0 || matchesDeclaredEnvironment(declared, env);
  const undeclared = ledgerEnvs.filter((e) => e !== LOCAL_ENVIRONMENT && !covered(e));
  if (undeclared.length > 0) {
    reasons.push({
      code: "environments-ledger-undeclared",
      message: `the ledger has releases in ${undeclared.join(", ")}, which chant.config.ts's environments don't cover, so chant run --env refuses ${undeclared.length === 1 ? "it" : "them"}`,
    });
  }

  const out: MemberEnvironments["environments"] = [];
  const add = (name: string, source: ComponentEnvironment["source"]) => {
    if (!out.some((e) => e.name === name)) out.push({ name, default: name === LOCAL_ENVIRONMENT, source });
  };
  add(LOCAL_ENVIRONMENT, literals.includes(LOCAL_ENVIRONMENT) ? "config" : ledgerEnvs.includes(LOCAL_ENVIRONMENT) ? "ledger" : "builtin");
  for (const name of literals) add(name, "config");
  for (const name of ledgerEnvs) if (covered(name)) add(name, "ledger");
  return { environments: out, reasons, declared };
}

/**
 * The environments one component may deploy to, each with its command line.
 * `declared` is what the component's contract says (#3153): an environment
 * the member lists takes its site, and one it doesn't is added after the
 * member's when `chant run --env` takes it. `reasons` collects the declared
 * environments left out because the config's environments don't cover them.
 * `hosts` are the runtimes the member configures; a site's runtime is used
 * for the command only when it is one of them.
 */
export function componentEnvironments(
  component: string,
  member: MemberEnvironments | undefined,
  runtime = LOCAL_RUNTIME,
  declared: readonly ComponentEnvironmentDeclaration[] = [],
  hosts: readonly string[] = [],
  reasons: EnvironmentReason[] = [],
): ComponentEnvironment[] {
  const list: Omit<ComponentEnvironment, "command" | "site">[] = [...(member?.environments ?? [{ name: LOCAL_ENVIRONMENT, default: true, source: "builtin" as const }])];
  const config = member?.declared;
  const takes = (env: string): boolean => !config || config.length === 0 || matchesDeclaredEnvironment(config, env);
  const sites = new Map<string, ComponentSite>();
  for (const d of declared) {
    sites.set(d.name, { runtime: d.runtime ?? null, url: d.url ?? null, domain: d.domain ?? null, lifecycle: d.lifecycle ?? null });
    if (list.some((e) => e.name === d.name)) continue;
    if (takes(d.name)) list.push({ name: d.name, default: false, source: "component" });
    else {
      reasons.push({
        code: "environments-component-undeclared",
        message: `component ${component} declares environment ${d.name}, which chant.config.ts's environments don't cover, so chant run --env refuses it`,
      });
    }
  }
  return list.map((e) => {
    const site = sites.get(e.name) ?? null;
    const on = site?.runtime && (site.runtime === LOCAL_RUNTIME || hosts.includes(site.runtime)) ? site.runtime : runtime;
    return { ...e, site, command: `chant run --components ${component}${on === LOCAL_RUNTIME ? "" : ` --on ${on}`}${e.default ? "" : ` --env ${e.name}`}` };
  });
}
