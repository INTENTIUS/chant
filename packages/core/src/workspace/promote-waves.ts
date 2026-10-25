/**
 * `chant workspace promote --all` (#4461): adopt a workspace of plain
 * Terraform roots into choudoufu in waves, a canary first.
 *
 * Each root goes through {@link promoteCommand} on its own, so each root has
 * its own gate, `workspace-promote/<member>`, whose digest binds that root's
 * own `live-import` report. A root that fails leaves every other root as it
 * was: its staging ran in a worktree, and nothing of it reached the tree.
 *
 * The order:
 *
 * - The canary (`--canary <member>`, else the first candidate in declaration
 *   order) is wave 1. Unless every canary lands, no other wave runs.
 * - The rest follow in declaration order, `--wave-size` roots a wave. Every
 *   root of a wave is tried even when one of them fails, and the next wave
 *   runs only when the whole wave landed.
 *
 * A root lands when it was applied, was already promoted, or (under
 * `--dry-run`) staged cleanly. A gated root has not landed: approve its gate
 * and run the same command again. Roots already of kind `choudoufu` report
 * `already-promoted` and are not staged again, so a re-run over a workspace
 * that has landed is a no-op.
 *
 * Before a root is staged its state is checked: `live-import` reads a local
 * tfstate of format version 4, so a missing state under a remote backend, or
 * a state of another version, refuses that root by name.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { GateLedgerPort } from "../op/gate";
import { readDeclaration } from "./declaration";
import { PROMOTE_GATED_EXIT, PromoteError, promoteCommand, type PromoteResult, type PromoteRunner } from "./promote";
import { workingTree } from "./tree";

export const DEFAULT_WAVE_SIZE = 5;

export type WaveRootOutcome =
  /** Staged, approved, kind written and markers stamped. */
  | "applied"
  /** Already of kind choudoufu (or above): nothing to do. */
  | "already-promoted"
  /** `--dry-run`: staged and checked, no gate recorded. */
  | "dry-run"
  /** A gate is pending for this root's digest. */
  | "gated"
  /** live-check or the live-import report failed in staging. */
  | "checks-failed"
  /** The state is not a local v4 tfstate. */
  | "refused"
  /** The kind was written but `live-import -approve` failed. */
  | "stamp-failed"
  /** Anything else that stopped the root (uncommitted changes, a patch that no longer applies). */
  | "failed"
  /** An earlier wave did not land. */
  | "not-run";

const LANDED: ReadonlySet<WaveRootOutcome> = new Set(["applied", "already-promoted", "dry-run"]);

export interface WaveRootResult {
  member: string;
  wave: number;
  canary: boolean;
  outcome: WaveRootOutcome;
  kind: string;
  state?: string;
  digest?: string;
  reportDigest?: string;
  /** From the report: instances eligible for stamping, of the total. */
  eligible?: { stampable: number; total: number };
  /** From the report: instances outside the admitted type set, never stamped. */
  unadmitted?: number;
  /** From the stamp report under -approve. */
  stamped?: { newly: number; already: number; failed: number };
  reason?: string;
}

export interface WavesSummary {
  outcome: "landed" | "gated" | "failed" | "dry-run";
  exitCode: number;
  waves: string[][];
  roots: WaveRootResult[];
}

export interface PromoteWavesOptions {
  root: string;
  /** Every terraform member, and every choudoufu member (which reports already-promoted). */
  all?: boolean;
  /** `--state <member>=<path>`, repeatable. Without `all`, the members named here are the set. */
  states?: Record<string, string>;
  /** `--state-dir <dir>`: a member's state is `<dir>/<member>.tfstate`. */
  stateDir?: string;
  canary?: string[];
  waveSize?: number;
  dryRun?: boolean;
  json?: boolean;
  /** For tests. */
  runner?: PromoteRunner;
  ledger?: GateLedgerPort;
  now?: string;
}

/** Parse `--state <member>=<path>` values. */
export function parseStateMappings(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const at = v.indexOf("=");
    if (at <= 0 || at === v.length - 1) throw new PromoteError(`--state with --all takes <member>=<terraform.tfstate>: got "${v}"`);
    const member = v.slice(0, at);
    if (out[member] !== undefined) throw new PromoteError(`--state names ${member} twice`);
    out[member] = v.slice(at + 1);
  }
  return out;
}

/** The waves: the canaries first, then the rest in declaration order, `size` at a time. */
export function planWaves(candidates: readonly string[], canary: readonly string[], size: number): string[][] {
  if (!Number.isInteger(size) || size < 1) throw new PromoteError(`--wave-size needs a whole number from 1: got ${size}`);
  for (const c of canary) {
    if (!candidates.includes(c)) throw new PromoteError(`--canary ${c} is not one of the roots being promoted (${candidates.join(", ") || "none"})`);
  }
  const first = canary.length > 0 ? [...new Set(canary)] : candidates.slice(0, 1);
  const rest = candidates.filter((m) => !first.includes(m));
  const waves = first.length > 0 ? [first] : [];
  for (let i = 0; i < rest.length; i += size) waves.push(rest.slice(i, i + size));
  return waves;
}

/** The backend a root's .tf files declare, or undefined for none or `local`. */
export function remoteBackend(dir: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".tf"));
  } catch {
    return undefined;
  }
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf-8").replace(/^\s*(#|\/\/).*$/gm, "");
    const backend = /\bbackend\s+"([^"]+)"/.exec(text);
    if (backend && backend[1] !== "local") return backend[1];
    if (/^\s*cloud\s*\{/m.test(text)) return "cloud";
  }
  return undefined;
}

/**
 * Why `state` cannot feed `live-import` for `member`, or undefined when it
 * can: it must be a local tfstate of format version 4.
 */
export function stateRefusal(member: string, memberDir: string, state: string): string | undefined {
  const backend = remoteBackend(memberDir);
  if (!existsSync(state)) {
    if (backend) {
      return `${member} uses the ${backend} backend and has no local state at ${state}: live-import reads a local tfstate, so run \`terraform state pull > ${state}\` in ${memberDir} first (or pass --state ${member}=<pulled file>)`;
    }
    return `${member} has no state at ${state}: pass --state ${member}=<terraform.tfstate> or --state-dir <dir>`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(state, "utf-8"));
  } catch {
    return `${member}: ${state} is not a JSON tfstate`;
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== 4) {
    const hint = (parsed as { backend?: unknown } | null)?.backend !== undefined
      ? " It looks like .terraform/terraform.tfstate, the backend's settings: run `terraform state pull` for the state itself."
      : "";
    return `${member}: ${state} is a version ${String(version)} state; live-import reads version 4 only (Terraform 0.12 and later).${hint}`;
  }
  return undefined;
}

function reportCounts(r: PromoteResult): Pick<WaveRootResult, "eligible" | "unadmitted"> {
  if (!r.adoption) return {};
  return {
    eligible: { stampable: r.adoption.claimed, total: r.adoption.total },
    unadmitted: r.adoption.entries.filter((e) => e.status === "UNADMITTED_TYPE").length,
  };
}

function stampCounts(text: string | undefined): WaveRootResult["stamped"] {
  const m = text ? /(\d+) resource\(s\) newly stamped, (\d+) already stamped, .*?(\d+) failed/.exec(text) : null;
  return m ? { newly: Number(m[1]), already: Number(m[2]), failed: Number(m[3]) } : undefined;
}

function rootOutcome(r: PromoteResult): WaveRootOutcome {
  if (r.outcome === "applied") return r.exitCode === 0 ? "applied" : "stamp-failed";
  if (r.outcome === "top-of-ladder") return "already-promoted";
  return r.outcome;
}

export async function promoteWavesCommand(opts: PromoteWavesOptions): Promise<WavesSummary> {
  const root = resolve(opts.root);
  const decl = readDeclaration(workingTree(root));
  const states = opts.states ?? {};
  const say = (m: string): void => {
    if (!opts.json) console.error(m);
  };

  for (const name of Object.keys(states)) {
    if (!decl.members.some((m) => m.name === name)) throw new PromoteError(`--state names ${name}, which the declaration has no member of`);
  }
  const selected = decl.members.filter((m) => (opts.all ? m.kind === "terraform" || m.kind === "choudoufu" : states[m.name] !== undefined));
  if (selected.length === 0) {
    throw new PromoteError(opts.all ? "the declaration has no member of kind terraform to promote" : "name the roots with --state <member>=<path>, or pass --all");
  }
  for (const m of selected) {
    if (m.kind !== "terraform" && m.kind !== "choudoufu") throw new PromoteError(`${m.name} is kind ${m.kind}; promote --all adopts terraform roots into choudoufu`);
  }

  // The waves are planned over every selected root, promoted or not, so a
  // re-run keeps the same waves and the same canary: an already promoted
  // root lands in its wave without being staged.
  const waves = planWaves(selected.map((m) => m.name), opts.canary ?? [], opts.waveSize ?? DEFAULT_WAVE_SIZE);
  const byName = new Map(selected.map((m) => [m.name, m]));
  const roots: WaveRootResult[] = [];

  const stateFor = (name: string): string => {
    const dir = byName.get(name)!.dir;
    if (states[name] !== undefined) return resolve(states[name]);
    if (opts.stateDir) return resolve(opts.stateDir, `${name}.tfstate`);
    return join(root, dir, "terraform.tfstate");
  };

  let stopped: string | undefined;
  for (const [i, wave] of waves.entries()) {
    const n = i + 1;
    const canary = i === 0;
    if (stopped) {
      for (const name of wave) roots.push({ member: name, wave: n, canary, outcome: "not-run", kind: byName.get(name)!.kind, reason: stopped });
      continue;
    }
    say(formatInfo(`wave ${n}${canary ? " (canary)" : ""}: ${wave.join(", ")}`));
    const results: WaveRootResult[] = [];
    for (const name of wave) {
      const member = byName.get(name)!;
      const state = stateFor(name);
      if (member.kind !== "terraform") {
        results.push({ member: name, wave: n, canary, outcome: "already-promoted", kind: member.kind, reason: `already kind ${member.kind}; nothing staged` });
        continue;
      }
      const row: WaveRootResult = { member: name, wave: n, canary, outcome: "failed", kind: member.kind, state };
      const refusal = stateRefusal(name, join(root, member.dir), state);
      if (refusal) {
        row.outcome = "refused";
        row.reason = refusal;
        say(formatError({ message: refusal }));
        results.push(row);
        continue;
      }
      try {
        const r = await promoteCommand({
          root,
          member: name,
          state,
          dryRun: opts.dryRun,
          json: opts.json,
          nested: true,
          ...(opts.runner ? { runner: opts.runner } : {}),
          ...(opts.ledger ? { ledger: opts.ledger } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        });
        row.outcome = rootOutcome(r);
        if (r.digest) row.digest = r.digest;
        if (r.reportDigest) row.reportDigest = r.reportDigest;
        Object.assign(row, reportCounts(r));
        const stamped = stampCounts(r.followUpOutput);
        if (stamped) row.stamped = stamped;
        if (row.outcome === "checks-failed") row.reason = r.failureOutput?.split("\n").at(-1) || "a staging check failed";
        if (row.outcome === "stamp-failed") {
          row.reason = `kind written, but ${r.followUpFailed} failed; live-import is safe to re-run: \`choudoufu live-import -state=${state} -estate=${name} -approve\` in ${member.dir}`;
        }
        if (row.outcome === "gated") row.reason = `approve with \`chant approve workspace-promote ${name}\`, then run this again`;
      } catch (err) {
        if (!(err instanceof PromoteError)) throw err;
        row.outcome = "failed";
        row.reason = err.message;
        say(formatError({ message: `${name}: ${err.message}` }));
      }
      results.push(row);
    }
    roots.push(...results);
    const short = results.filter((r) => !LANDED.has(r.outcome));
    if (short.length > 0) {
      stopped = `${canary ? "the canary wave" : `wave ${n}`} did not land (${short.map((r) => `${r.member} ${r.outcome}`).join(", ")})`;
    }
  }

  const failed = roots.some((r) => r.outcome === "refused" || r.outcome === "checks-failed" || r.outcome === "failed" || r.outcome === "stamp-failed");
  const gated = roots.some((r) => r.outcome === "gated");
  const outcome: WavesSummary["outcome"] = failed ? "failed" : gated ? "gated" : opts.dryRun ? "dry-run" : "landed";
  const exitCode = failed ? 1 : gated ? PROMOTE_GATED_EXIT : 0;
  const summary: WavesSummary = { outcome, exitCode, waves, roots };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    say("");
    for (const r of roots) {
      const counts = [
        r.eligible ? `${r.eligible.stampable} of ${r.eligible.total} stampable` : "",
        r.unadmitted ? `${r.unadmitted} unadmitted, not stamped` : "",
        r.stamped ? `${r.stamped.newly} newly stamped, ${r.stamped.already} already stamped, ${r.stamped.failed} failed` : "",
      ].filter(Boolean).join("; ");
      const where = `wave ${r.wave}${r.canary ? " canary" : ""}`;
      const line = `${r.member}  ${where}  ${r.outcome}${counts ? `  (${counts})` : ""}${r.reason ? `: ${r.reason}` : ""}`;
      say(LANDED.has(r.outcome) ? formatInfo(line) : r.outcome === "gated" || r.outcome === "not-run" ? formatWarning({ message: line }) : formatError({ message: line }));
    }
    if (outcome === "landed") say(formatSuccess(`every root landed. Review and commit the declaration.`));
    else if (outcome === "gated") say(formatInfo("approve the pending gates and run the same command again; landed roots are not staged twice"));
  }
  return summary;
}
