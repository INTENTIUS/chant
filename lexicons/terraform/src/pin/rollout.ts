/**
 * Roll a module version out as pin-bump pull requests, one wave at a time
 * (#3189, choudoufu#1749).
 *
 * Each run reads where the rollout stands and does at most one thing:
 *
 * 1. It checks out the base branch in a temporary worktree and reads every
 *    root's pin there: at the old version, at the new one, refused (a
 *    floating constraint, no pin, an expression), or pinned at something
 *    else. Only roots at the old or the new version are in the rollout, so
 *    the wave plan is the same on every run.
 * 2. It splits those roots into waves (`./waves.ts`).
 * 3. It walks the waves in order, reading each wave's pull request by its
 *    branch. A wave whose PR merged, and whose every moved root reports its
 *    apply check as passed on the merge commit, is done. The first wave that
 *    is not done decides the run:
 *    - no PR yet: open it (one branch, one PR, the pin moved for that wave's
 *      roots only), or in `report` mode say it would;
 *    - PR open, or merged with an apply still pending: report where it
 *      stands and open nothing;
 *    - PR closed without merging, or a root whose apply check failed: stop,
 *      naming it. The waves after it do not open.
 *
 * That is #2119's gate as a fact: nothing waits. The next run reads the
 * forge again and either moves on or reports the same place.
 *
 * The PR's branch is built from the base branch in a worktree and pushed.
 * The default branch, and whatever the caller has checked out, are never
 * written, as with core's `proposeWorkspaceUpgrade` (#2550). Each PR changes
 * only the files of its wave's roots, so a path-diff selection (GitLab's
 * `rules: changes:`, #3183's affected members) plans exactly those roots.
 *
 * An "applied" root is one whose apply check, named by `appliedCheck`
 * (default `apply/{root}`), passed on the merge commit. That is how a
 * per-root apply job on the merged commit reports today; when the per-PR
 * loop (#3183) lands, its per-member check name is the one to pass.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import type { CommandRunner } from "@intentius/chant/op/activities/propose-upgrade";
import { editPins, type PinCallResult, type PinEditResult, type PinRequest } from "./edit";
import { checkPinRequest, moduleOf } from "./source";
import { planPinWaves, restrictWaves, terragruntDependencies, type PinRoot, type PinWave } from "./waves";
import { ghPinForge, type PinForge } from "./forge";

const execFileAsync = promisify(execFile);

/** Edits the module declaration in a generated root's TypeScript source (`./edit-ts.ts`). */
export type TsPinEditor = (text: string, file: string, request: PinRequest) => PinEditResult;

export type PinRolloutMode = "report" | "pull-request";

export interface PinRolloutOptions extends PinRequest {
  /** A directory inside the repository. Default: the working directory. */
  cwd?: string;
  /** The roots to roll out. Default: every directory under the repository with a `.tf` file or a `terragrunt.hcl` that calls the module. */
  roots?: PinRoot[];
  /** Roots that form wave 1. */
  canaries?: string[];
  /** A wave plan to use instead of canaries and dependency order, such as {@link wavesFromChoudoufu}'s. */
  waves?: PinWave[];
  /** `report` (default) opens nothing; `pull-request` opens the next wave's PR when it is due. */
  mode?: PinRolloutMode;
  /** The branch PRs target. Default: the remote's default branch. */
  base?: string;
  /** Default `origin`. */
  remote?: string;
  /** The check each moved root's apply reports on the merge commit. `{root}` is the root's directory. Default `apply/{root}`. */
  appliedCheck?: string;
  /** The HCL reader, `loadHcl2json()` from `@intentius/chant/terraform/hcl2json`. */
  parser: Hcl2Json;
  /** The forge. Default: `gh`, through `run`. */
  forge?: PinForge;
  /** Runs `git` (and `gh`, for the default forge). For tests. */
  run?: CommandRunner;
  /** The TypeScript editor for generated roots. Without it, a root with `tsSource` is refused. */
  editTs?: TsPinEditor;
  /** Markdown appended to a wave's PR body, such as the grouped plan summary of #3188 once a caller has the wave's plans. */
  planSummary?: (wave: PinWave) => Promise<string | undefined>;
}

/** Where one root's pin stood on the base branch. */
export interface PinRootState {
  root: string;
  /** `from`: at least one call moves; `to`: every call is already moved; the rest are not in the rollout. */
  state: "from" | "to" | "refused" | "elsewhere" | "absent";
  files: string[];
  calls: PinCallResult[];
  reason?: string;
}

export type PinWaveState =
  | "applied"
  | "nothing-to-move"
  | "opened"
  | "would-open"
  | "open"
  | "waiting-apply"
  | "failed"
  | "closed"
  | "not-reached";

export interface PinWaveStatus extends PinWave {
  branch: string;
  state: PinWaveState;
  pr?: string;
  /** Roots whose apply check has not reported yet. */
  pending?: string[];
  /** Roots whose apply check failed. */
  failed?: string[];
  /** Files the wave's PR changes (`opened` and `would-open`). */
  files?: string[];
}

export interface PinRolloutResult extends PinRequest {
  mode: PinRolloutMode;
  base: string;
  /**
   * `complete`: every wave applied. `opened`/`would-open`: the next wave's PR
   * was opened, or would be. `waiting`: a PR is open or an apply has not
   * reported. `stopped`: a root failed or a PR closed unmerged, and `stop` says
   * which.
   */
  status: "complete" | "opened" | "would-open" | "waiting" | "stopped";
  roots: PinRootState[];
  waves: PinWaveStatus[];
  stop?: string;
  summary: string;
}

const defaultRun: CommandRunner = async (bin, args, cwd) => (await execFileAsync(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

const SKIP_DIRS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules"]);

const NO_FORGE: PinForge = {
  findPullRequest: async () => null,
  createPullRequest: async () => {
    throw new Error("pin rollout: no forge to open a pull request on");
  },
  commitChecks: async () => [],
};

/** The marker that ties a PR to its wave, and carries the roots it moved. */
const MARKER = "chant-pin-rollout";

/** A root directory as the rollout keys it: relative, `/`-separated, no `./` and no trailing slash. */
function dirOf(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/\/+$/, "") || ".";
}

function slug(value: string): string {
  const s = value.replace(/^[a-z]+:\/\//, "").replace(/^sha256:([0-9a-f]{12})[0-9a-f]*$/i, "sha256-$1");
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** The branch a wave's PR is opened from. */
export function pinWaveBranch(request: PinRequest, wave: number): string {
  return `chant/pin/${slug(request.module)}/${slug(request.to)}/wave-${wave}`;
}

/** The files the pin edit reads in a root directory: its `.tf` files and its `terragrunt.hcl`. */
function rootFiles(worktree: string, root: string): string[] {
  const dir = join(worktree, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf") || f === "terragrunt.hcl")
    .sort()
    .map((f) => posix.join(root, f));
}

/** Every directory under the worktree with a `.tf` file or a `terragrunt.hcl`. */
function candidateRoots(worktree: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const entries = readdirSync(join(worktree, rel), { withFileTypes: true });
    if (entries.some((e) => e.isFile() && (e.name.endsWith(".tf") || e.name === "terragrunt.hcl"))) out.push(rel || ".");
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(rel ? posix.join(rel, e.name) : e.name);
  };
  walk("");
  return out.sort();
}

async function editRoot(worktree: string, root: PinRoot, request: PinRequest, options: PinRolloutOptions): Promise<{ state: PinRootState; edits: Map<string, string> }> {
  const edits = new Map<string, string>();
  const calls: PinCallResult[] = [];
  let files: string[];
  if (root.tsSource) {
    files = [root.tsSource];
    if (!options.editTs) {
      return { state: { root: root.root, state: "refused", files, calls, reason: `generated from ${root.tsSource}, and this caller has no TypeScript editor` }, edits };
    }
  } else {
    files = rootFiles(worktree, root.root);
  }
  for (const file of files) {
    const path = join(worktree, file);
    if (!existsSync(path)) return { state: { root: root.root, state: "refused", files, calls, reason: `${file} does not exist on the base branch` }, edits };
    const text = readFileSync(path, "utf-8");
    const result = root.tsSource ? options.editTs!(text, file, request) : await editPins(text, file, request, options.parser);
    calls.push(...result.calls);
    if (result.content !== text) edits.set(file, result.content);
  }
  const refused = calls.filter((c) => c.outcome === "refused");
  let state: PinRootState["state"];
  let reason: string | undefined;
  if (calls.length === 0) {
    state = "absent";
    reason = "no call of the module";
  } else if (refused.length > 0) {
    state = "refused";
    reason = refused.map((c) => `${c.file} ${c.call}: ${"reason" in c ? c.reason : ""}`).join("; ");
  } else if (calls.some((c) => c.outcome === "moved")) {
    state = calls.some((c) => c.outcome === "elsewhere") ? "refused" : "from";
    if (state === "refused") reason = "some calls are pinned at another version than the old one";
  } else if (calls.every((c) => c.outcome === "already")) {
    state = "to";
  } else {
    state = "elsewhere";
    reason = calls.map((c) => ("pin" in c ? `${c.file} ${c.call}: pinned at ${c.pin}` : "")).filter(Boolean).join("; ");
  }
  return { state: { root: root.root, state, files, calls, ...(reason ? { reason } : {}) }, edits: state === "from" ? edits : new Map() };
}

function parseMarker(body: string): { roots?: string[] } | null {
  const m = new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`).exec(body);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as { roots?: string[] };
  } catch {
    return null;
  }
}

function prBody(request: PinRequest, wave: PinWave, total: number, moved: PinRootState[], refused: PinRootState[], checkName: (root: string) => string, summary?: string): string {
  const marker = JSON.stringify({ module: request.module, from: request.from, to: request.to, wave: wave.wave, roots: moved.map((r) => r.root) });
  return [
    `<!-- ${MARKER} ${marker} -->`,
    `## Pin bump, wave ${wave.wave} of ${total}${wave.canary ? " (canaries)" : ""}`,
    "",
    `\`${request.module}\` pin ${request.from} -> ${request.to}`,
    "",
    `Roots in this wave (${moved.length}):`,
    "",
    ...moved.map((r) => `- \`${r.root}\`: ${r.calls.filter((c) => c.outcome === "moved").map((c) => `${c.file} ${c.call}`).join(", ")}`),
    "",
    "This PR changes only these roots' files, so a path-diff selection plans exactly these roots.",
    ...(refused.length > 0 ? ["", "Not moved by this rollout:", "", ...refused.map((r) => `- \`${r.root}\`: ${r.reason}`)] : []),
    ...(summary ? ["", summary] : []),
    "",
    wave.wave < total
      ? `Wave ${wave.wave + 1} opens on a later run, once this PR has merged and each root above reports its apply check (${moved.length > 0 ? `\`${checkName(moved[0]!.root)}\`` : "none"}${moved.length > 1 ? " and the rest" : ""}) as passed on the merge commit.`
      : "This is the last wave.",
    "",
    "Opened by the terraform lexicon's pin rollout. It never writes the default branch.",
  ].join("\n");
}

async function defaultBranch(run: CommandRunner, repo: string, remote: string): Promise<string | null> {
  try {
    const ref = (await run("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], repo)).trim();
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
  } catch {
    return null;
  }
}

/** Read where a rollout stands, and open the next wave's PR when it is due and `mode` is `pull-request`. */
export async function runPinRollout(options: PinRolloutOptions): Promise<PinRolloutResult> {
  const request: PinRequest = { module: moduleOf(options.module), from: options.from, to: options.to };
  checkPinRequest(request);
  const mode = options.mode ?? "report";
  const run = options.run ?? defaultRun;
  const remote = options.remote ?? "origin";
  const repo = (await run("git", ["rev-parse", "--show-toplevel"], options.cwd ?? process.cwd())).trim();
  const checkName = (root: string) => (options.appliedCheck ?? "apply/{root}").replaceAll("{root}", root);

  let hasRemote = true;
  try {
    await run("git", ["remote", "get-url", remote], repo);
  } catch {
    hasRemote = false;
  }
  if (mode === "pull-request" && !hasRemote) throw new Error(`pin rollout: no remote "${remote}" to open a pull request on`);
  // With no remote there is no forge to have opened a PR on, so a report reads every wave as unopened.
  const forge = options.forge ?? (hasRemote ? ghPinForge(run, repo) : NO_FORGE);
  if (hasRemote) await run("git", ["fetch", "--quiet", remote], repo);
  const base = options.base ?? (hasRemote ? await defaultBranch(run, repo, remote) : null) ?? (await run("git", ["symbolic-ref", "--short", "HEAD"], repo)).trim();
  const baseRef = hasRemote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;

  const worktree = mkdtempSync(join(tmpdir(), "chant-pin-"));
  await run("git", ["worktree", "add", "--quiet", "--detach", worktree, baseRef], repo);
  try {
    // 1. Every root's pin on the base branch.
    const declared = (options.roots ?? candidateRoots(worktree).map((root): PinRoot => ({ root }))).map((r) => ({
      ...r,
      root: dirOf(r.root),
      ...(r.dependsOn ? { dependsOn: r.dependsOn.map(dirOf) } : {}),
    }));
    const roots: PinRootState[] = [];
    const edits = new Map<string, Map<string, string>>();
    const byRoot = new Map<string, PinRoot>();
    for (const root of declared) {
      const { state, edits: e } = await editRoot(worktree, root, request, options);
      if (options.roots || state.state !== "absent") roots.push(state);
      edits.set(root.root, e);
      byRoot.set(root.root, root);
    }
    const inRollout = roots.filter((r) => r.state === "from" || r.state === "to");
    const outside = roots.filter((r) => !(r.state === "from" || r.state === "to"));

    // 2. The waves, over the roots at the old or the new pin.
    const keep = new Set(inRollout.map((r) => r.root));
    let waves: PinWave[];
    if (options.waves) {
      waves = restrictWaves(options.waves, keep);
      const planned = new Set(waves.flatMap((w) => w.roots));
      const missing = [...keep].filter((r) => !planned.has(r));
      if (missing.length > 0) throw new Error(`pin rollout: the wave plan does not place ${missing.join(", ")}`);
    } else {
      const withDeps: PinRoot[] = [];
      for (const r of inRollout) {
        const declaredRoot = byRoot.get(r.root)!;
        const tg = join(worktree, r.root, "terragrunt.hcl");
        const fromTg = !declaredRoot.tsSource && existsSync(tg) && statSync(tg).isFile() ? await terragruntDependencies(r.root, readFileSync(tg, "utf-8"), options.parser) : [];
        withDeps.push({ ...declaredRoot, dependsOn: [...new Set([...(declaredRoot.dependsOn ?? []), ...fromTg])] });
      }
      // A canary that is a root but out of the rollout (refused, say) is dropped; one that is no root at all is refused by the planner.
      const canaries = (options.canaries ?? []).map(dirOf);
      waves = planPinWaves(withDeps, canaries.filter((c) => keep.has(c) || !roots.some((r) => r.root === c)));
    }

    // 3. Walk the waves.
    const statuses: PinWaveStatus[] = waves.map((w) => ({ ...w, branch: pinWaveBranch(request, w.wave), state: "not-reached" }));
    let status: PinRolloutResult["status"] = "complete";
    let stop: string | undefined;
    for (const wave of statuses) {
      if (wave.branch === base) throw new Error(`pin rollout will not write the base branch "${base}"`);
      const pr = await forge.findPullRequest(wave.branch);
      if (pr) wave.pr = pr.url;
      if (pr?.state === "open") {
        wave.state = "open";
        status = "waiting";
        break;
      }
      if (pr?.state === "closed") {
        wave.state = "closed";
        status = "stopped";
        stop = `wave ${wave.wave}'s PR ${pr.url} was closed without merging`;
        break;
      }
      if (pr?.state === "merged") {
        const moved = parseMarker(pr.body)?.roots ?? wave.roots;
        const checks = pr.mergeCommit ? await forge.commitChecks(pr.mergeCommit) : [];
        const stateOf = (root: string) => checks.find((c) => c.name === checkName(root))?.state ?? "pending";
        wave.failed = moved.filter((r) => stateOf(r) === "failure");
        wave.pending = moved.filter((r) => stateOf(r) === "pending");
        if (wave.failed.length > 0) {
          wave.state = "failed";
          status = "stopped";
          stop = `wave ${wave.wave}: ${wave.failed.map((r) => `${r} failed its apply check ${checkName(r)}`).join(", ")}`;
          break;
        }
        if (wave.pending.length > 0) {
          wave.state = "waiting-apply";
          status = "waiting";
          break;
        }
        wave.state = "applied";
        continue;
      }
      // No PR yet: this wave is next.
      const moving = roots.filter((r) => wave.roots.includes(r.root) && r.state === "from");
      if (moving.length === 0) {
        wave.state = "nothing-to-move";
        continue;
      }
      const files = moving.flatMap((r) => [...edits.get(r.root)!.keys()]).sort();
      wave.files = files;
      if (mode === "report") {
        wave.state = "would-open";
        status = "would-open";
        break;
      }
      for (const r of moving) for (const [file, content] of edits.get(r.root)!) writeFileSync(join(worktree, file), content);
      const title = `chore(pin): ${request.module} ${request.from} -> ${request.to}, wave ${wave.wave} of ${statuses.length}`;
      const summary = options.planSummary ? await options.planSummary(wave) : undefined;
      const body = prBody(request, wave, statuses.length, moving, outside, checkName, summary);
      await run("git", ["add", "--", ...files], worktree);
      const identity: string[] = [];
      const has = async (key: string) => {
        try {
          return (await run("git", ["config", key], worktree)).trim().length > 0;
        } catch {
          return false;
        }
      };
      if (!(await has("user.name"))) identity.push("-c", "user.name=chant");
      if (!(await has("user.email"))) identity.push("-c", "user.email=chant@localhost");
      await run("git", [...identity, "commit", "--quiet", "--no-verify", "-m", `${title}\n\nRoots: ${moving.map((r) => r.root).join(", ")}\n`], worktree);
      // The branch is rebuilt from the base branch on every run that opens it, so it is replaced.
      await run("git", ["push", "--quiet", "--force", remote, `HEAD:refs/heads/${wave.branch}`], worktree);
      wave.pr = await forge.createPullRequest({ base, head: wave.branch, title, body });
      wave.state = "opened";
      status = "opened";
      break;
    }
    if (statuses.length === 0) status = "complete";

    const result: PinRolloutResult = { ...request, mode, base, status, roots, waves: statuses, ...(stop ? { stop } : {}), summary: "" };
    result.summary = renderPinRollout(result);
    return result;
  } finally {
    try {
      await run("git", ["worktree", "remove", "--force", worktree], repo);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

const WAVE_TEXT: Record<PinWaveState, string> = {
  applied: "merged and applied",
  "nothing-to-move": "nothing to move",
  opened: "PR opened",
  "would-open": "next; would open its PR",
  open: "PR open, waiting for merge",
  "waiting-apply": "merged, waiting for apply",
  failed: "merged, apply failed",
  closed: "PR closed without merging",
  "not-reached": "not opened",
};

/** The rollout for a terminal or a run log. */
export function renderPinRollout(result: Omit<PinRolloutResult, "summary">): string {
  const lines = [`${result.module} pin ${result.from} -> ${result.to} on ${result.base}: ${result.status}${result.stop ? ` (${result.stop})` : ""}`];
  for (const w of result.waves) {
    lines.push(`  wave ${w.wave}${w.canary ? " (canaries)" : ""}: ${WAVE_TEXT[w.state]}${w.pr ? ` ${w.pr}` : ""}`);
    lines.push(`    roots: ${w.roots.join(", ")}`);
    if (w.pending?.length) lines.push(`    apply pending: ${w.pending.join(", ")}`);
    if (w.failed?.length) lines.push(`    apply failed: ${w.failed.join(", ")}`);
    if (w.files?.length) lines.push(`    files: ${w.files.join(", ")}`);
  }
  for (const r of result.roots.filter((r) => r.state !== "from" && r.state !== "to")) lines.push(`  not in the rollout: ${r.root}: ${r.reason ?? r.state}`);
  return lines.join("\n");
}

