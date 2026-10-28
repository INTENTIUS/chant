/**
 * Gate-time policy (#4294): a policy engine run over a plan's change set,
 * with the policy read at base, whose rules deny a plan or hold it for a
 * person.
 *
 * The engine is any command that prints conftest's JSON result
 * (`conftest test --output json`) or OPA's (`opa eval --format json`). The
 * rules are counted as conftest counts them:
 *
 * - `deny`, `violation`, `deny_<name>` and `violation_<name>` deny the plan.
 *   A denied plan applies only under an override that counts
 *   (`./override-gate.ts`), on top of the gate's own approval.
 * - `hold` and `hold_<name>` hold the plan: it waits for a person's approval
 *   of its digest, even where the gate would let it through without one.
 *   conftest runs only deny and warn rules, so a hold needs the opa shape.
 * - `warn` and `warn_<name>` are advice. They fail nothing.
 *
 * There is no outcome that lets a plan apply with nobody approving it: a
 * non-empty change set always waits for a person (ws-104, ws-080). A rule
 * named `allow_unattended` is read as no rule at all.
 *
 * A policy that cannot run, or gives no answer this module can read, is an
 * error, and the caller stops the apply: no path waives a policy.
 *
 * Like `./override-gate.ts` this module reads what it is handed and imports
 * only node built-ins, so a product can bundle it into one file
 * (`gate-policy-bundle.test.ts`). The pull-request jobs' use of it is in
 * `./components/pr-policy.ts`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `ci.policy.source` (#4613): its shape and check, here so this module
// bundles alone (#4294). `./policy-source.ts` fetches it.

/** `ci.policy.source`: where the shared rules live. */
export interface GatePolicySource {
  /** The repository: an `https://`, `http://`, `ssh://` or `file://` URL, or `git@<host>:<path>`. */
  repo: string;
  /** A tag, a branch or a full commit. */
  ref: string;
  /** The Rego directory inside the repository. Default `policy`. */
  path?: string;
}

/** The source as fetched: what a report and a decision record. */
export interface ResolvedGatePolicySource {
  /** The repository, with any user and password left out. */
  repo: string;
  ref: string;
  /** The commit the ref named when the job fetched it. */
  commit: string;
  /** The Rego directory inside the repository. */
  path: string;
}

const REPO = /^(https?:\/\/[^\s/]+\/\S+|ssh:\/\/[^\s/]+\/\S+|file:\/\/\/?\S+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+)$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `source`, checked. Throws with what is wrong. `where` names it, such as `ci.policy.source`. */
export function assertGatePolicySource(where: string, raw: unknown): asserts raw is GatePolicySource {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be { repo, ref, path? }`);
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "repo" && key !== "ref" && key !== "path") throw new Error(`${where}.${key} is not a setting; the settings are repo, ref and path`);
  }
  if (typeof o.repo !== "string" || !REPO.test(o.repo) || o.repo.startsWith("-")) {
    throw new Error(`${where}.repo must be a git URL (https://, ssh://, file:// or git@<host>:<path>)`);
  }
  if (typeof o.ref !== "string" || !REF.test(o.ref) || o.ref.includes("..") || o.ref.endsWith("/")) {
    throw new Error(`${where}.ref must be a tag, a branch or a commit`);
  }
  if (o.path !== undefined) {
    if (typeof o.path !== "string" || o.path.trim() === "") throw new Error(`${where}.path must be a non-empty string`);
    if (o.path.startsWith("/") || o.path.split("/").includes("..")) throw new Error(`${where}.path must be a directory inside the source repository`);
  }
}



/** The result shapes chant reads: conftest's and OPA's. */
export const GATE_POLICY_ENGINES = ["conftest", "opa"] as const;
export type GatePolicyEngine = (typeof GATE_POLICY_ENGINES)[number];

/** Where the policy is read when the settings name no `path`. */
export const DEFAULT_POLICY_PATH = "policy";

/** The settings of one policy step, read at base. */
export interface GatePolicySettings {
  /** The result shape, and the default command. Default `conftest`. */
  engine?: GatePolicyEngine;
  /**
   * The policy directory, relative to the declaration at base. Default
   * {@link DEFAULT_POLICY_PATH}. Refused beside `source`, whose own `path`
   * names the directory inside the shared repository.
   */
  path?: string;
  /**
   * A shared policy repository pinned by ref (#4613), read in place of the
   * workspace's own directory. The ref is fetched by the job, never taken
   * from the pull request's head.
   */
  source?: GatePolicySource;
  /**
   * CrossGuard packs every Pulumi stack's preview runs (#4613): each `dir`
   * relative to the declaration at base, or to the top of `source` when it
   * is set, and copied from there, so a pull request cannot drop or edit
   * the packs that judge it. `config` is the pack's
   * `--policy-pack-config` file, read the same way.
   */
  packs?: GatePolicyPack[];
  /** The package to read. conftest default: every namespace. opa default: `main`. */
  namespace?: string;
  /**
   * The command to run instead of the engine's own, as argv. `{policy}` is
   * the policy directory exported from base and `{input}` the input file. It
   * prints the result shape `engine` names.
   */
  command?: string[];
}

/** One CrossGuard pack named by `ci.policy.packs`. */
export interface GatePolicyPack {
  dir: string;
  config?: string;
}

/** A rule that matched, and what it said. */
export interface GatePolicyFinding {
  /** `<package>.<rule>`, such as `main.deny_public_bucket`. */
  rule: string;
  message: string;
}

/** What an engine's answer holds. */
export interface GatePolicyFindings {
  denials: GatePolicyFinding[];
  holds: GatePolicyFinding[];
  warnings: string[];
}

/**
 * One policy check's outcome. `denied` wins over `held`. `error`: the
 * policy did not run or gave no readable answer, and the apply stops.
 */
export interface GatePolicyVerdict {
  result: "passed" | "denied" | "held" | "error";
  engine: GatePolicyEngine;
  denials: GatePolicyFinding[];
  /** The ids of the rules that denied, sorted, each once: what an override names. */
  rules: string[];
  holds: GatePolicyFinding[];
  warnings: string[];
  error?: string;
  /** The shared source the rules came from (#4613), with the commit read. Absent when they came from the workspace at base. */
  source?: ResolvedGatePolicySource;
}

export const DENY_RULE = /^(deny|violation)(_[A-Za-z0-9]+)*$/;
export const WARN_RULE = /^warn(_[A-Za-z0-9]+)*$/;
export const HOLD_RULE = /^hold(_[A-Za-z0-9]+)*$/;

const ruleId = (query: string): string => query.replace(/^data\./, "");

function messageOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { msg?: unknown }).msg === "string") return (v as { msg: string }).msg;
  return JSON.stringify(v);
}

/** The findings in `conftest test --output json`. Undefined when it is not that shape. */
export function conftestFindings(stdout: string): GatePolicyFindings | undefined {
  let results: unknown;
  try {
    results = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(results)) return undefined;
  const out: GatePolicyFindings = { denials: [], holds: [], warnings: [] };
  for (const r of results as Array<{ namespace?: string; failures?: Array<{ msg?: unknown; metadata?: { query?: unknown } }>; warnings?: Array<{ msg?: unknown }> }>) {
    if (r === null || typeof r !== "object") return undefined;
    for (const f of r.failures ?? []) {
      // conftest names the query that denied in the failure's metadata; an older one gives only the namespace.
      const rule = typeof f.metadata?.query === "string" ? ruleId(f.metadata.query) : `${r.namespace ?? "main"}.deny`;
      out.denials.push({ rule, message: messageOf(f.msg) });
    }
    for (const w of r.warnings ?? []) out.warnings.push(messageOf(w.msg));
  }
  return out;
}

/** The rules of one package's value, and with `nested` its child packages one level down. */
function packageFindings(doc: Record<string, unknown>, out: GatePolicyFindings, pkg: string, nested: boolean): void {
  for (const [name, value] of Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // A rule matches when its value is true, a message, or a non-empty set of messages.
    const said = Array.isArray(value) ? value.map(messageOf) : value === true ? [name] : typeof value === "string" && value !== "" ? [value] : [];
    if (DENY_RULE.test(name)) {
      for (const message of said) out.denials.push({ rule: `${pkg}.${name}`, message });
    } else if (HOLD_RULE.test(name)) {
      for (const message of said) out.holds.push({ rule: `${pkg}.${name}`, message });
    } else if (WARN_RULE.test(name)) {
      out.warnings.push(...said);
    } else if (nested && value !== null && typeof value === "object" && !Array.isArray(value)) {
      packageFindings(value as Record<string, unknown>, out, `${pkg}.${name}`, false);
    }
  }
}

/**
 * The findings in `opa eval --format json data.<namespace>`. The query's
 * value is the package: its rules are read by name. An array value is a
 * deny set named after the query. A query that is undefined has no rule
 * that matched. Undefined when the output is not that shape.
 */
export function opaFindings(stdout: string, namespace = "main"): GatePolicyFindings | undefined {
  let parsed: { result?: Array<{ expressions?: Array<{ value?: unknown }> }>; errors?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.errors !== undefined) return undefined;
  const value = parsed.result?.[0]?.expressions?.[0]?.value;
  const out: GatePolicyFindings = { denials: [], holds: [], warnings: [] };
  if (value === undefined) return out;
  if (Array.isArray(value)) {
    out.denials.push(...value.map((v) => ({ rule: namespace, message: messageOf(v) })));
    return out;
  }
  if (value === null || typeof value !== "object") return undefined;
  packageFindings(value as Record<string, unknown>, out, namespace, true);
  return out;
}

/** A verdict from what the engine found. */
export function gatePolicyVerdict(engine: GatePolicyEngine, found: GatePolicyFindings): GatePolicyVerdict {
  const rules = [...new Set(found.denials.map((d) => d.rule))].sort();
  return {
    result: found.denials.length > 0 ? "denied" : found.holds.length > 0 ? "held" : "passed",
    engine,
    denials: found.denials,
    rules,
    holds: found.holds,
    warnings: found.warnings,
  };
}

const errorVerdict = (engine: GatePolicyEngine, error: string): GatePolicyVerdict => ({ result: "error", engine, denials: [], rules: [], holds: [], warnings: [], error });

/** The argv one check runs: the settings' `command` with its placeholders filled, or the engine's own. */
export function gatePolicyArgv(settings: GatePolicySettings, at: { policy: string; input: string }): string[] {
  if (settings.command) return settings.command.map((a) => a.replaceAll("{policy}", at.policy).replaceAll("{input}", at.input));
  if ((settings.engine ?? "conftest") === "opa") {
    return ["opa", "eval", "--format", "json", "--data", at.policy, "--input", at.input, `data.${settings.namespace ?? "main"}`];
  }
  return ["conftest", "test", "--no-color", "--output", "json", "--policy", at.policy, ...(settings.namespace ? ["--namespace", settings.namespace] : ["--all-namespaces"]), at.input];
}

/** What one run of the engine printed and how it exited. `status` is null when it did not start. */
export interface GatePolicyRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GatePolicyExec = (argv: string[], cwd: string) => GatePolicyRun;

/** Runs the engine with the job's environment. */
export const defaultGatePolicyExec: GatePolicyExec = (argv, cwd) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

export interface CheckGatePolicyOptions {
  settings: GatePolicySettings;
  /** The input document, or its JSON text. */
  input: unknown;
  /** The policy directory, already exported from base. */
  policyDir: string;
  /** Where the engine runs. Default the policy directory. */
  cwd?: string;
  exec?: GatePolicyExec;
}

const tail = (text: string): string => text.trim().split("\n").slice(-3).join(" ");

/** Run the engine once over `input` and read its answer. */
export function checkGatePolicy(options: CheckGatePolicyOptions): GatePolicyVerdict {
  const { settings } = options;
  const engine = settings.engine ?? "conftest";
  const work = mkdtempSync(join(tmpdir(), "chant-policy-input-"));
  try {
    const file = join(work, "input.json");
    writeFileSync(file, typeof options.input === "string" ? options.input : JSON.stringify(options.input));
    const argv = gatePolicyArgv(settings, { policy: options.policyDir, input: file });
    const r = (options.exec ?? defaultGatePolicyExec)(argv, options.cwd ?? options.policyDir);
    if (r.status === null) return errorVerdict(engine, `${argv[0]} did not run: ${tail(r.stderr) || "no such command"}`);
    const found = engine === "opa" ? opaFindings(r.stdout, settings.namespace ?? "main") : conftestFindings(r.stdout);
    if (found === undefined) return errorVerdict(engine, `${argv[0]} gave no ${engine} result (exit ${r.status}): ${tail(r.stderr || r.stdout)}`);
    // conftest exits 1 on a denial and 2 or more when it could not run; opa exits 0 on a query it ran.
    if (found.denials.length === 0 && r.status !== 0) return errorVerdict(engine, `${argv[0]} exited ${r.status}: ${tail(r.stderr)}`);
    return gatePolicyVerdict(engine, found);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The part of a tree a policy is exported from: a workspace tree at base fits. */
export interface GatePolicyTree {
  stat(path: string): "file" | "dir" | undefined;
  list(path: string): Array<{ name: string; type: "file" | "dir" }> | undefined;
  read(path: string): string;
  bytes?(path: string): Uint8Array;
}

/**
 * Copy the policy directory `path` out of `tree` (the tree at base) into a
 * new temporary directory, so the engine reads the policy as the base has
 * it and never the change's copy. Returns the directory and how to remove
 * it, or the reason there is no policy to read.
 */
export function exportGatePolicy(tree: GatePolicyTree, path: string): { dir: string; cleanup: () => void } | { error: string } {
  const root = path.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const kind = root === "" || root === "." ? "dir" : tree.stat(root);
  if (kind === undefined) return { error: `the policy directory ${path} does not exist at base` };
  const dir = mkdtempSync(join(tmpdir(), "chant-policy-"));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  const copy = (from: string, to: string): void => {
    for (const entry of tree.list(from) ?? []) {
      const src = from === "" || from === "." ? entry.name : `${from}/${entry.name}`;
      const dest = join(to, entry.name);
      if (entry.type === "dir") {
        mkdirSync(dest, { recursive: true });
        copy(src, dest);
      } else {
        writeFileSync(dest, tree.bytes ? tree.bytes(src) : tree.read(src));
      }
    }
  };
  try {
    if (kind === "file") writeFileSync(join(dir, root.split("/").pop()!), tree.bytes ? tree.bytes(root) : tree.read(root));
    else copy(root, dir);
  } catch (err) {
    cleanup();
    return { error: `the policy at ${path} could not be read at base: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { dir, cleanup };
}

/** The settings, checked. Throws with what is wrong. `where` names them, such as `ci.policy`. */
export function assertGatePolicySettings(where: string, raw: unknown): asserts raw is GatePolicySettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be { engine?, path?, source?, namespace?, command?, packs? }`);
  if ("path" in raw && "source" in raw) throw new Error(`${where}.path and ${where}.source cannot both be set; with a source, ${where}.source.path names the directory inside it`);
  for (const [key, value] of Object.entries(raw)) {
    if (key === "engine") {
      if (!(GATE_POLICY_ENGINES as readonly unknown[]).includes(value)) throw new Error(`${where}.engine must be ${GATE_POLICY_ENGINES.join(" or ")}, the result shape the command prints`);
    } else if (key === "path" || key === "namespace") {
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}.${key} must be a non-empty string`);
      if (key === "path" && (value.startsWith("/") || value.split("/").includes(".."))) throw new Error(`${where}.path must be a directory inside the workspace, relative to its declaration`);
    } else if (key === "source") {
      assertGatePolicySource(`${where}.source`, value);
    } else if (key === "packs") {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}.packs must be a non-empty list of { dir, config? }`);
      value.forEach((p: unknown, i: number) => {
        const at = `${where}.packs[${i}]`;
        if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at} must be { dir, config? }`);
        for (const [k, v] of Object.entries(p)) {
          if (k !== "dir" && k !== "config") throw new Error(`${at}.${k} is not a setting; the settings are dir and config`);
          if (typeof v !== "string" || v.trim() === "") throw new Error(`${at}.${k} must be a non-empty string`);
          if (v.startsWith("/") || v.split("/").includes("..")) throw new Error(`${at}.${k} must be a path inside the workspace, or inside the source when one is set`);
        }
        if (typeof (p as { dir?: unknown }).dir !== "string") throw new Error(`${at}.dir is required`);
      });
    } else if (key === "command") {
      if (!Array.isArray(value) || value.length === 0 || !value.every((a) => typeof a === "string" && a !== "")) throw new Error(`${where}.command must be argv, a non-empty list of strings`);
      if (!value.some((a: string) => a.includes("{input}"))) throw new Error(`${where}.command must pass the input file as {input}`);
    } else if (key === "outcomes" || key === "allow_unattended" || key === "allowUnattended") {
      throw new Error(`${where}.${key}: chant's policy step denies and holds only; a non-empty plan always waits for a person (ws-104), so there is no unattended outcome`);
    } else {
      throw new Error(`${where}.${key} is not a setting; the settings are engine, path, source, namespace, command and packs`);
    }
  }
}
