/**
 * `chant workspace ref-gate` (#4867): refuse a ref update that lacks the
 * evidence the policy at base requires. See ./ref-gate.ts.
 *
 * - `pre-receive` and `pre-push` are what the hooks `install` writes run;
 *   they read git's hook input on standard input.
 * - `check --ref <ref>` decides one update from a checkout, and records the
 *   request for an override of each blocked check, as `pre-push` does.
 * - `status --ref <ref>` decides the update a merge would make and sets the
 *   commit status the forge requires, so the forge refuses the merge.
 * - `attach --envelope <file>` attaches runner evidence to a commit.
 * - `install --hook pre-receive|pre-push` writes the hook.
 *
 * With `--json` each prints the `ref-gate.schema.json` document.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatError, formatSuccess } from "../../cli/format";
import type { CommandContext } from "../../cli/registry";
import { readerVersion } from "../declaration";
import {
  appendRefGateLedger,
  attachEvidence,
  commitOf,
  decideRefUpdate,
  describeDecision,
  readRefGateLedger,
  refGateLedgerPath,
  RefUpdateInputError,
  runPrePush,
  runPreReceive,
  spentOverrides,
  type RefDecision,
  type RefGateErrorCode,
  type RefGateSite,
} from "./ref-gate";
import { resolveBase } from "./provenance";
import { spawnSync } from "node:child_process";

export const REF_GATE_CONTRACT_VERSION = 1;
export const REF_GATE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ref-gate/v1/ref-gate.schema.json";
/** The line a hook chant writes carries, so `install` knows it may replace it. */
export const REF_GATE_HOOK_MARK = "# chant ref gate (#4867)";
/** How long a recorded request for an override stands. */
const OVERRIDE_REQUEST_HOURS = 72;

const USAGE =
  "chant workspace ref-gate check --ref <ref> [--at <rev>] [--base <rev>] [--dry-run] [--ledger <file>] [--json]\n" +
  "  chant workspace ref-gate status --ref <ref> [--at <rev>] [--base <rev>] [--dry-run] [--ledger <file>] [--json]\n" +
  "  chant workspace ref-gate status --open --ref refs/heads/<branch> [--base <rev>] [--dry-run] [--ledger <file>] [--json]\n" +
  "  chant workspace ref-gate pre-receive|pre-push [--ledger <file>] [--dry-run] [--json]   (git hook input on stdin)\n" +
  "  chant workspace ref-gate attach --envelope <file> [--at <rev>]\n" +
  "  chant workspace ref-gate install --hook pre-receive|pre-push [--git-dir <dir>] [--chant <command>]";

function head(): { $schema: string; contract: number; chant: string } {
  return { $schema: REF_GATE_OUTPUT_SCHEMA_ID, contract: REF_GATE_CONTRACT_VERSION, chant: readerVersion() };
}

function fail(json: boolean | undefined, code: RefGateErrorCode, message: string): number {
  if (json) console.log(JSON.stringify({ ...head(), error: { code, message } }, null, 2));
  else console.error(formatError({ message: `${message} (${code})` }));
  return 1;
}

function usage(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return 1;
}

/** The git directory of the current directory, bare or not, and the work tree root when there is one. */
function repoHere(): { repo: string; bare: boolean } | null {
  const r = spawnSync("git", ["rev-parse", "--is-bare-repository", "--show-toplevel"], { encoding: "utf-8" });
  if (r.status !== 0) {
    const g = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf-8" });
    return g.status === 0 ? { repo: g.stdout.trim(), bare: true } : null;
  }
  const [bare, top] = r.stdout.trim().split("\n");
  if (bare === "true" || !top) {
    const g = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf-8" });
    return { repo: g.stdout.trim(), bare: true };
  }
  return { repo: top, bare: false };
}

function print(json: boolean | undefined, decisions: RefDecision[], ledger: string | undefined, stream: "out" | "err", site?: RefGateSite): void {
  const ok = decisions.every((d) => d.decision === "admit");
  if (json) {
    console.log(JSON.stringify({ ...head(), ok, ...(ledger ? { ledger } : {}), decisions }, null, 2));
    return;
  }
  for (const d of decisions) {
    if (d.status === null && d.checks.length === 0 && !d.error) continue;
    const text = describeDecision(d, site ? { site } : {}).join("\n");
    if (stream === "err" || d.decision === "refuse") console.error(text);
    else console.log(text);
  }
}

/**
 * Record the request for an override of each blocked check, unless one
 * stands, so a person can answer it with `chant approve policy-override`.
 * Needs a checkout with `chant/lifecycle`; a failure to record is said and
 * does not change the decision.
 */
async function recordRequests(repo: string, decisions: RefDecision[], now: string): Promise<void> {
  const blocked = decisions.flatMap((d) => d.checks.filter((c) => c.action === "block" && (c.status === "missing" || c.status === "stale")).map((c) => ({ d, c })));
  if (blocked.length === 0) return;
  const { readOverrideLedger, recordOverrideDenial } = await import("../../lifecycle/override-ledger");
  const { recordedDenials } = await import("../../override-gate");
  try {
    const standing = recordedDenials((await readOverrideLedger({ cwd: repo })).pending);
    for (const { d, c } of blocked) {
      const s = standing.find((x) => x.gate === c.subject);
      if (s && Date.parse(s.expiresAt) > Date.parse(now) && s.plan === d.new) continue;
      await recordOverrideDenial(
        {
          subject: c.subject,
          planDigest: d.new!,
          rules: [c.check],
          timestamp: now,
          expiresAt: new Date(Date.parse(now) + OVERRIDE_REQUEST_HOURS * 3_600_000).toISOString(),
          description: `update of ${d.ref} to ${d.new!.slice(0, 12)}, which has no current evidence for ${c.check}`,
        },
        { cwd: repo },
      );
    }
    console.error(`chant ref gate: the request for an override of ${blocked.map((b) => b.c.subject).join(", ")} is recorded on chant/lifecycle; push chant/lifecycle with the override.`);
  } catch (err) {
    console.error(`chant ref gate: could not record the request for an override: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runWorkspaceRefGate(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const sub = args.extraPositional;
  const subs = ["check", "status", "pre-receive", "pre-push", "attach", "install"];
  if (!sub || !subs.includes(sub)) return usage(sub ? `Unknown ref-gate subcommand: ${sub}` : `chant workspace ref-gate needs one of ${subs.join(", ")}`);
  const here = repoHere();
  if (!here) return fail(args.json, "not-a-git-repository", "the ref gate judges git ref updates, and this directory is not in a git repository");
  const now = new Date().toISOString();

  if (sub === "install") return install(here.repo, args.hook, args.gitDir, args.ciChant);

  if (sub === "attach") {
    if (!args.envelope) return usage("--envelope <file> is required");
    const commit = commitOf(here.repo, args.at ?? "HEAD");
    if (!commit) return fail(args.json, "revision-unknown", `--at ${args.at ?? "HEAD"} names no commit`);
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(args.envelope, "utf-8"));
    } catch (err) {
      return usage(`--envelope ${args.envelope} could not be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    attachEvidence(here.repo, commit, envelope);
    console.error(formatSuccess(`attached the evidence to ${commit.slice(0, 8)}; push refs/notes/chant/evidence with the ref`));
    return 0;
  }

  if (sub === "pre-receive" || sub === "pre-push") {
    const stdin = readFileSync(0, "utf-8");
    try {
      if (sub === "pre-receive") {
        const r = runPreReceive(here.repo, stdin, { ...(args.ledger ? { ledger: args.ledger } : {}), now });
        print(args.json, r.decisions, r.ledger, "err", "pre-receive");
        return r.ok ? 0 : 1;
      }
      const r = runPrePush(here.repo, stdin, { ...(args.ledger ? { ledger: args.ledger } : {}), now, base: (repo) => resolveBase(repo).commit });
      print(args.json, r.decisions, r.ledger, "err");
      if (!r.ok && !args.dryRun && !here.bare) await recordRequests(here.repo, r.decisions, now);
      return r.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof RefUpdateInputError) return fail(args.json, "ref-update-invalid", err.message);
      throw err;
    }
  }

  // check and status: one update, from a checkout or a CI job.
  if (!args.ref || !args.ref.startsWith("refs/")) return usage("--ref <ref> is required, as a full ref name such as refs/heads/main");
  if (args.open) {
    if (sub !== "status") return usage("--open sets the status of every open pull request, so it goes with status");
    return statusOpen(here.repo, args.ref, args.base, args.ledger, args.dryRun === true, args.json, now);
  }
  const at = commitOf(here.repo, args.at ?? "HEAD");
  if (!at) return fail(args.json, "revision-unknown", `--at ${args.at ?? "HEAD"} names no commit`);
  const resolved = resolveBase(here.repo, args.base);
  if (args.base !== undefined && !resolved.commit) return fail(args.json, "revision-unknown", resolved.problem ?? `--base ${args.base} names no commit`);
  const site: RefGateSite = sub === "status" ? "status" : "check";
  const ledger = args.ledger ?? refGateLedgerPath(here.repo);
  const spent = spentOverrides(readRefGateLedger(ledger));
  const d = decideRefUpdate({ repo: here.repo, update: { ref: args.ref, old: resolved.commit, new: at }, base: resolved.commit, spent, now });
  if (!args.dryRun) appendRefGateLedger(ledger, [{ ...d, version: 1, kind: "ref-update", site, timestamp: now }]);
  print(args.json, [d], args.dryRun ? undefined : ledger, "out");
  if (site === "check" && d.decision === "refuse" && !args.dryRun && !here.bare) await recordRequests(here.repo, [d], now);
  if (site === "status" && d.status !== null) {
    if (args.dryRun) {
      console.error(`chant ref gate: would set ${d.status} to ${d.decision === "admit" ? "success" : "failure"} on ${at.slice(0, 8)}`);
    } else {
      const { detectForge, forgeFromEnv } = await import("../../pr-forge");
      const kind = detectForge();
      if (!kind) {
        console.error(formatError({ message: `no forge detected, so ${d.status} was not set`, hint: "run it in a GitHub, GitLab or Forgejo job, or pass --dry-run" }));
        return 1;
      }
      await postRefGateStatus(forgeFromEnv(kind), d);
    }
  }
  return d.decision === "admit" ? 0 : 1;
}

/**
 * `status --open --ref refs/heads/<branch>` (#4935): the status of every open
 * pull request into the branch, from a pipeline of the branch. GitLab sets a
 * commit status only with the protected token a target-branch pipeline holds
 * (#4328), so its generated `ref-gate` job runs here, beside the plan notes.
 * Each head is fetched and decided as `status --at <head>` decides it, against
 * the policy at `base` (default this checkout's `HEAD`, the branch's commit).
 * A head that does not fetch, or a forge that refuses one status, is said
 * and the others go on. Exits 0 once each is set, whatever it decided: each
 * pull request's status says it.
 */
async function statusOpen(repo: string, ref: string, baseRev: string | undefined, ledgerFlag: string | undefined, dryRun: boolean, json: boolean | undefined, now: string): Promise<number> {
  if (!ref.startsWith("refs/heads/")) return usage("--open names the branch the pull requests merge into: --ref refs/heads/<branch>");
  const base = commitOf(repo, baseRev ?? "HEAD");
  if (!base) return fail(json, "revision-unknown", `--base ${baseRev ?? "HEAD"} names no commit`);
  const { detectForge, forgeFromEnv } = await import("../../pr-forge");
  const kind = detectForge();
  if (!kind && !dryRun) {
    console.error(formatError({ message: "no forge detected, so no status was set", hint: "run it in a GitHub, GitLab or Forgejo job, or pass --dry-run" }));
    return 1;
  }
  const forge = kind ? forgeFromEnv(kind) : undefined;
  if (!forge?.openPullRequests) return fail(json, "ref-update-invalid", `--open lists the open pull requests, which ${kind ?? "no"} forge client here can`);
  const branch = ref.slice("refs/heads/".length);
  const ledger = ledgerFlag ?? refGateLedgerPath(repo);
  const decisions: RefDecision[] = [];
  for (const pr of await forge.openPullRequests(branch)) {
    const fetched = spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", pr.headSha], { cwd: repo, encoding: "utf-8" });
    if (!commitOf(repo, pr.headSha)) {
      console.error(`chant ref gate: #${pr.number}'s head ${pr.headSha.slice(0, 8)} did not fetch${fetched.stderr ? ` (${fetched.stderr.trim().split("\n")[0]})` : ""}, so its status is left as it is`);
      continue;
    }
    const spent = spentOverrides(readRefGateLedger(ledger));
    const d = decideRefUpdate({ repo, update: { ref, old: base, new: pr.headSha }, base, spent, now });
    decisions.push(d);
    if (dryRun) {
      if (d.status !== null) console.error(`chant ref gate: would set ${d.status} to ${d.decision === "admit" ? "success" : "failure"} on #${pr.number} at ${pr.headSha.slice(0, 8)}`);
      continue;
    }
    appendRefGateLedger(ledger, [{ ...d, version: 1, kind: "ref-update", site: "status", timestamp: now }]);
    try {
      await postRefGateStatus(forge, d);
    } catch (err) {
      console.error(`chant ref gate: could not set the status on #${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  print(json, decisions, dryRun ? undefined : ledger, "err");
  if (decisions.length === 0) console.error(`chant ref gate: no open pull request into ${branch} to set a status on`);
  return 0;
}

/** The commit status a forge requires for `d`'s ref: `success` when it is admitted, `failure` naming the missing checks when not. */
export async function postRefGateStatus(forge: { setStatus(sha: string, status: { context: string; state: "success" | "failure"; description: string }): Promise<void> }, d: RefDecision): Promise<void> {
  if (d.status === null || d.new === null) return;
  const missing = d.checks.filter((c) => c.action === "block" && (c.status === "missing" || c.status === "stale"));
  const overridden = d.checks.filter((c) => c.status === "overridden").map((c) => c.check);
  const description = d.error
    ? `refused: ${d.error.code}`
    : missing.length > 0
      ? `missing evidence: ${missing.map((c) => `${c.check} (run ${c.command})`).join(", ")}`
      : `evidence current${overridden.length ? `; overridden: ${overridden.join(", ")}` : ""}`;
  await forge.setStatus(d.new, { context: d.status, state: d.decision === "admit" ? "success" : "failure", description });
}

/** The hook script: it runs `chant` (or `command`) with the hook's arguments and input. */
export function refGateHook(hook: "pre-receive" | "pre-push", command = "chant"): string {
  return `#!/bin/sh\n${REF_GATE_HOOK_MARK}\nexec ${command} workspace ref-gate ${hook} "$@"\n`;
}

function install(repo: string, hook: string | undefined, gitDir: string | undefined, command: string | undefined): number {
  if (hook !== "pre-receive" && hook !== "pre-push") return usage("--hook pre-receive (on the remote) or --hook pre-push (in a checkout) is required");
  let dir = gitDir;
  if (!dir) {
    const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repo, encoding: "utf-8" });
    dir = r.status === 0 ? join(repo, r.stdout.trim()) : join(repo, "hooks");
    if (r.status === 0 && r.stdout.trim().startsWith("/")) dir = r.stdout.trim();
  } else {
    dir = join(dir, "hooks");
  }
  const path = join(dir, hook);
  if (existsSync(path) && !readFileSync(path, "utf-8").includes(REF_GATE_HOOK_MARK)) {
    console.error(formatError({ message: `${path} exists and is not chant's ref gate hook; it was left as it is`, hint: `call ${command ?? "chant"} workspace ref-gate ${hook} from it` }));
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, refGateHook(hook, command));
  chmodSync(path, 0o755);
  console.error(formatSuccess(`wrote ${path}`));
  return 0;
}
