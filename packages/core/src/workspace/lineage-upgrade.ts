/**
 * `chant workspace upgrade <scope>`: bring one lineage scope to a newer
 * version of its template (#2550, D9, ws-005, ws-032).
 *
 * The upgrade is a core command, never an Op the template ships, so the
 * template cannot change the rules that judge its own upgrade. It works in the
 * six steps of D9:
 *
 * 1. Fetch the target version of the template. For a git source that is one
 *    `git fetch` of the target ref, plus the commit the scope was made from.
 *    This is the command's only network step, catalogued in
 *    `test/egress-catalogue.ts`. A local repository reaches nothing, and
 *    neither does a directory source (#2647), which reads `--to <dir>`.
 * 2. Rebuild the merge base offline: each recorded file's content at the base
 *    commit, kept only when it has the hash the lock recorded. A file the
 *    project never edited is its own merge base. Vendor sources keep no
 *    history, so only unedited vendored files have a base.
 * 3. Migrate in a separate git worktree, checked out at HEAD under
 *    `.chant/upgrade/`. The chain is planned from the template's
 *    `.chant/migrations/`, and a gap refuses the upgrade.
 * 4. Merge per file (ws-005): an edited file takes the new version only when
 *    every hunk merges cleanly. Otherwise it stays as it was, with one manual
 *    step. The worktree never holds conflict markers.
 * 5. Check the worktree: `chant build` and `chant lint` when the project is a
 *    chant project, and the lineage checks of `chant workspace check`.
 * 6. Bind the gate to the digest of the resulting patch: the pending fact and
 *    the approval name it, so an approval covers exactly this patch.
 *
 * The project's own tree changes only once the gate is approved, when the
 * patch is applied to it. A patch that changes governance files (Op files,
 * `chant.config`, CI workflows, CODEOWNERS) needs human approvals, as many as
 * the strictest gate in the Op files it changes asks for at HEAD. The
 * upgraded Op files never decide their own gate.
 */

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { ResolvedGateApproval } from "../op/gate-approval";
import { checkLineage, findingKey, type CheckFinding } from "./lineage-check";
import { dirLabel, git, parseDirSpec, readTemplateDir, readTemplateTree, recordedDirPath } from "./lineage-init";
import {
  LOCK_FILE,
  LockError,
  contentDigest,
  fileHash,
  readLock,
  renderLock,
  scopeKey,
  writeLock,
  type Lineage,
  type LineageLock,
  type LineageSource,
  type ManualStep,
} from "./lineage-lock";
import { mergeFile } from "./lineage-merge";
import { assertCodeAllowed, planMigrations, runMigration, splitMigrations, type LoadedMigration } from "./lineage-migrations";
import { applyUpstream, type UpdateResult } from "./lineage-update";
import { carryParameters, readManifest, substituteParameters } from "./template-manifest";
import { repinSubstituted, type RepinnedRecord } from "./template-pins";

/** The kind the patch digest is taken under, so it never collides with another kind of plan. */
export const UPGRADE_PLAN_KIND = "workspace-upgrade";

/** Where staging worktrees live, relative to the project root. */
export const UPGRADE_DIR = ".chant/upgrade";

export class UpgradeError extends LockError {
  override name = "UpgradeError";
}

// ── Checks ───────────────────────────────────────────────────────────────────

export interface UpgradeCheck {
  name: "build" | "lint" | "workspace check";
  status: "passed" | "failed" | "skipped";
  /** Why a check was skipped, or the tail of a failed command's output. */
  detail?: string;
}

/** Runs `chant build` or `chant lint` in a directory. */
export type ChantRunner = (command: "build" | "lint", cwd: string) => Promise<{ exitCode: number; output: string }>;

/**
 * The default runner: this same chant, in a child process. The child sees the
 * worktree's sources and resolves packages the way the project does, since the
 * worktree sits inside the project.
 */
export const spawnChant: ChantRunner = (command, cwd) =>
  new Promise((resolvePromise, reject) => {
    const entry = process.argv[1];
    if (!entry) {
      reject(new UpgradeError("cannot find the chant entry point to run build and lint in the worktree"));
      return;
    }
    const child = spawn(process.execPath, [...process.execArgv, entry, command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => out.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, output: Buffer.concat(out).toString("utf-8") }));
  });

// ── Options and result ───────────────────────────────────────────────────────

export interface UpgradeOptions {
  /** The directory holding `.chant/workspace.lock.json`. */
  root: string;
  /** The scope to upgrade: `"."` or a vendor scope's directory. */
  scope?: string;
  /**
   * The target ref (git) or label (vendor). Defaults to the ref the scope is
   * pinned at. For a directory source, the directory holding the new version,
   * as `<dir>[#<member>]`, resolved from the current directory; the member
   * defaults to the recorded one.
   */
  to?: string;
  /** Run migrations whose body is code. */
  allowCode?: boolean;
  /** Replaces the child-process build and lint. For tests. */
  runChant?: ChantRunner;
}

export interface GovernanceChange {
  /** Changed governance paths, relative to the repository root. */
  paths: string[];
  /** The approval the gate asks for, from the rules at HEAD. */
  approval: ResolvedGateApproval;
  /** Where the rules came from. */
  rules: string;
}

export interface StagedUpgrade {
  scope: string;
  template: string;
  kind: Lineage["kind"];
  /** The pin before and after. */
  from: string | null;
  to: string | null;
  commit?: { from?: string; to: string };
  migrations: string[];
  written: string[];
  merged: string[];
  removed: string[];
  kept: string[];
  skipped: UpdateResult["skipped"];
  manualSteps: ManualStep[];
  /** Paths the patch changes, relative to the repository root. */
  changedPaths: string[];
  patch: string;
  /**
   * The new lock. When git tracks it, its change is in `patch`. A template
   * whose `.gitignore` covers `.chant/` leaves it untracked; the text is then
   * applied beside the patch and covered by the digest on its own.
   */
  lock: { path: string; tracked: boolean; text: string };
  /** Whether the upgrade changes anything: the patch, or an untracked lock. */
  changed: boolean;
  /** `computePlanDigest(UPGRADE_PLAN_KIND, { scope, patch })`, plus `lock` when untracked: what the gate binds. */
  digest: string;
  governance: GovernanceChange | null;
  checks: UpgradeCheck[];
  checksOk: boolean;
  /** The repository root and the commit the worktree was made from. */
  repo: string;
  head: string;
  /** The staging worktree, and the project root inside it. */
  worktree: string;
  worktreeProject: string;
  /** Remove the worktree. Safe to call twice. */
  dispose(): void;
}

// ── Fetch and base ───────────────────────────────────────────────────────────

interface Upstream {
  files: Map<string, Buffer>;
  executable: Set<string>;
  base: Map<string, Buffer>;
  migrations: LoadedMigration[];
  modules: Map<string, Buffer>;
  commit?: string;
  tree?: string;
  /** The parameter values substituted into `files` (#2627), for a git or directory source. */
  parameters?: Record<string, string>;
  /** The records re-pinned to substituted files (#2549). */
  repinned?: RepinnedRecord[];
  /** The source the lock records after the upgrade, when it moves (a directory source). */
  source?: LineageSource;
}

/**
 * The template's files as the project would have them (#2627): the manifest
 * removed and the parameters substituted, with the recorded values and the
 * defaults of parameters this version adds. Records that pin a substituted
 * file are re-pinned as init re-pinned them (#2549), for the base and the
 * target alike, so an unedited record compares equal to its base.
 */
function instantiate(
  raw: Map<string, Buffer>,
  recorded: Record<string, unknown>,
  label: string,
): { files: Map<string, Buffer>; parameters: Record<string, string>; repinned: RepinnedRecord[] } {
  try {
    const manifest = readManifest(raw);
    const parameters = carryParameters(manifest, recorded);
    const { files, repinned } = repinSubstituted(raw, substituteParameters(raw, manifest, parameters), manifest?.files ?? []);
    return { files, parameters, repinned };
  } catch (err) {
    throw new UpgradeError(`${label}: ${(err as Error).message.replace(/; pass --param .*$/, "")}`);
  }
}

/**
 * Fetch the target ref, and the commit the scope was made from, of a git
 * source into a scratch repository, and read both trees. The base fetch may
 * fail (a server that refuses fetches by commit); the base is then left empty,
 * and every edited file the template changed becomes a manual step.
 */
function fetchGit(root: string, lineage: Lineage, ref: string): Upstream {
  const source = lineage.source;
  if (source.type !== "git") throw new UpgradeError("not a git source");
  const url = source.url.startsWith(".") ? resolve(root, source.url) : source.url;
  const label = `${source.repo}@${ref}`;
  const scratch = mkdtempSync(join(tmpdir(), "chant-upgrade-"));
  try {
    git(scratch, ["init", "-q"]);
    try {
      // The network step of `chant workspace upgrade`, catalogued in test/egress-catalogue.ts.
      git(scratch, ["fetch", "-q", "--depth", "1", url, ref]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.toString().trim();
      throw new UpgradeError(`could not fetch ${label}${stderr ? `: ${stderr}` : ""}`);
    }
    const commit = git(scratch, ["rev-parse", "FETCH_HEAD^{commit}"]);
    const target = readTemplateTree(scratch, commit, source.path, label);

    const raw = new Map<string, Buffer>();
    const executable = new Set<string>();
    for (const [path, f] of target.files) {
      raw.set(path, f.data);
      if (f.executable) executable.add(path);
    }
    // The target with the scope's parameters substituted (#2627), so an
    // unedited file that carries a value compares equal to its base.
    const instantiated = instantiate(raw, lineage.parameters, label);

    let base = new Map<string, Buffer>();
    const baseCommit = lineage.address?.commit;
    if (baseCommit && baseCommit !== commit) {
      try {
        git(scratch, ["fetch", "-q", "--depth", "1", url, baseCommit]);
        const oldLabel = `${source.repo}@${baseCommit.slice(0, 12)}`;
        const old = readTemplateTree(scratch, baseCommit, source.path, oldLabel);
        // The base is rebuilt the way init wrote it: the old version's
        // manifest, with the values the lock recorded.
        base = instantiate(new Map([...old.files].map(([path, f]) => [path, f.data])), lineage.parameters, oldLabel).files;
      } catch {
        // No base from the source; the tree still supplies it for unedited files.
      }
    } else if (baseCommit) {
      base = new Map(instantiated.files);
    }

    const split = splitMigrations(instantiated.files);
    return {
      files: split.files,
      executable,
      base,
      migrations: split.migrations,
      modules: split.modules,
      commit,
      tree: target.tree,
      parameters: instantiated.parameters,
      repinned: instantiated.repinned,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Why a directory scope cannot be upgraded, with the way out. A directory
 * has no history, so the merge base exists only while the files the scope
 * was made from are still on disk.
 */
function dirRefusal(lineage: Lineage, why: string): UpgradeError {
  const source = lineage.source as Extract<LineageSource, { type: "dir" }>;
  return new UpgradeError(
    `${why}. The scope was made from the directory ${dirLabel(source.path, source.member)}, which has no git history to rebuild a merge base from. ` +
      `Upgrade with --to <dir> while ${source.path} still holds the files the scope was made from, or adopt the scope into a git lineage with \`chant workspace adopt-lineage\` (#2551).`,
  );
}

/**
 * The upstream of a directory source (#2647): the new version from the
 * directory `to` names, and the merge base from the recorded directory, used
 * only when its files, instantiated with the recorded parameters, still have
 * the recorded digest. Anything else is refused: a base that is not the one
 * the scope was made from would turn the project's edits into upstream
 * changes. Reaches no network.
 */
function readDir(root: string, lineage: Lineage, to: string | undefined): Upstream {
  const source = lineage.source;
  if (source.type !== "dir") throw new UpgradeError("not a directory source");
  if (!to) throw dirRefusal(lineage, "no --to directory");

  let target;
  try {
    target = parseDirSpec(to);
  } catch {
    target = null;
  }
  if (!target) throw new UpgradeError(`--to ${to}: a scope made from a directory upgrades from a directory, and ${to} is not one`);
  const member = to.includes("#") ? target.member : source.member;
  const label = dirLabel(target.path, member);
  const read = readTemplateDir(target.abs, member, label);
  const raw = new Map<string, Buffer>();
  const executable = new Set<string>();
  for (const [path, f] of read.files) {
    raw.set(path, f.data);
    if (f.executable) executable.add(path);
  }
  const instantiated = instantiate(raw, lineage.parameters, label);

  // The merge base: the recorded directory, only while it holds exactly what the scope was made from.
  const original = resolve(root, source.path);
  const originalLabel = dirLabel(source.path, source.member);
  let base: Map<string, Buffer>;
  try {
    const old = readTemplateDir(original, source.member, originalLabel);
    base = splitMigrations(instantiate(new Map([...old.files].map(([path, f]) => [path, f.data])), lineage.parameters, originalLabel).files).files;
  } catch {
    throw dirRefusal(lineage, `${originalLabel} is gone`);
  }
  if (!lineage.address || contentDigest(base) !== lineage.address.digest) {
    throw dirRefusal(lineage, `${originalLabel} no longer holds the files the scope was made from (its digest is not ${lineage.address?.digest ?? "recorded"})`);
  }

  const split = splitMigrations(instantiated.files);
  return {
    files: split.files,
    executable,
    base,
    migrations: split.migrations,
    modules: split.modules,
    parameters: instantiated.parameters,
    repinned: instantiated.repinned,
    source: { type: "dir", path: recordedDirPath(target.path, target.abs, root), ...(member ? { member } : {}) },
  };
}

async function fetchUpstream(root: string, lineage: Lineage, ref: string | undefined): Promise<Upstream> {
  const source = lineage.source;
  if (source.type === "git") {
    if (!ref) throw new UpgradeError("the scope records no ref; pass --to <ref>");
    return fetchGit(root, lineage, ref);
  }
  if (source.type === "local" || source.type === "archive") {
    const { resolveVendorSource } = await import("../cli/commands/vendor");
    const files = await resolveVendorSource(source, root);
    return { files, executable: new Set(), base: new Map(), migrations: [], modules: new Map() };
  }
  if (source.type === "dir") return readDir(root, lineage, ref);
  throw new UpgradeError(
    `scope made by \`chant init --template\` (${lineage.template}) cannot be upgraded yet: its merge base is the older lexicon's render, which is not available offline. Upgrade git-sourced and vendor scopes for now.`,
  );
}

/** The merge base per recorded file: from the source's old version, or from an unedited file in the tree. */
function rebuildBase(scopeDir: string, lineage: Lineage, fromSource: Map<string, Buffer>): Map<string, Buffer> {
  const base = new Map<string, Buffer>();
  for (const [path, entry] of Object.entries(lineage.files)) {
    const old = fromSource.get(path);
    if (old && fileHash(old) === entry.sha256) {
      base.set(path, old);
      continue;
    }
    const abs = join(scopeDir, path);
    if (existsSync(abs)) {
      const data = readFileSync(abs);
      if (fileHash(data) === entry.sha256) base.set(path, data);
    }
  }
  return base;
}

// ── Governance ───────────────────────────────────────────────────────────────

const GOVERNANCE = [
  /(^|\/)[^/]+\.op\.[cm]?[jt]s$/,
  /(^|\/)chant\.config\.(ts|js|mjs|cjs|json)$/,
  /(^|\/)chant\.workspace\.jsonc?$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.forgejo\/workflows\//,
  /(^|\/)\.gitea\/workflows\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)CODEOWNERS$/,
];

/** Whether a repository path is a governance file: one that decides gates, pipelines or review. */
export function isGovernancePath(path: string): boolean {
  return GOVERNANCE.some((re) => re.test(path));
}

/**
 * The approval an upgrade gate asks for when the patch changes governance
 * files. Only human approvals count, and the gate needs as many as the
 * strictest gate declared at HEAD in any Op file the patch changes, at least
 * one. The Op files are read from the project's tree, which the upgrade
 * requires to match HEAD for every path the patch touches.
 */
async function rulesAtHead(root: string, repo: string, paths: string[]): Promise<ResolvedGateApproval> {
  const opFiles = new Set(paths.filter((p) => GOVERNANCE[0].test(p)));
  let count = 1;
  let roles: string[] | undefined;
  if (opFiles.size > 0) {
    const { discoverOps } = await import("../op/discover");
    const { ops } = await discoverOps({ cwd: root });
    for (const { config, filePath } of ops.values()) {
      const rel = relative(repo, filePath).split(sep).join("/");
      if (!opFiles.has(rel)) continue;
      for (const approval of gateApprovals(config)) {
        const need = approval.quorum?.count ?? 1;
        if (need > count) {
          count = need;
          roles = approval.quorum?.roles;
        }
      }
    }
  }
  return { mode: "log-only", quorum: { count, ...(roles && roles.length > 0 ? { roles } : {}) } };
}

type StepLike = { kind: string; approval?: { quorum?: { count: number; roles?: string[] } }; steps?: StepLike[] };

function gateApprovals(config: { phases?: Array<{ steps: StepLike[] }>; onFailure?: Array<{ steps: StepLike[] }> }): Array<{ quorum?: { count: number; roles?: string[] } }> {
  const out: Array<{ quorum?: { count: number; roles?: string[] } }> = [];
  const visit = (step: StepLike): void => {
    if (step.kind === "gate") out.push(step.approval ?? {});
    if (step.kind === "effect") (step.steps ?? []).forEach(visit);
  };
  for (const p of [...(config.phases ?? []), ...(config.onFailure ?? [])]) p.steps.forEach(visit);
  return out;
}

// ── Stage ────────────────────────────────────────────────────────────────────

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function isChantProject(dir: string): boolean {
  return ["chant.config.ts", "chant.config.json", "chant.config.js", "chant.config.mjs"].some((f) => existsSync(join(dir, f)));
}

function tail(text: string, lines = 30): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Stage an upgrade: steps 1 to 5 and the digest of step 6. Nothing in the
 * project's tree changes. The caller decides the gate, then applies the patch
 * with {@link applyStagedUpgrade} or commits it with {@link commitStagedUpgrade},
 * and always calls `dispose()`.
 */
export async function stageUpgrade(options: UpgradeOptions): Promise<StagedUpgrade> {
  const root = resolve(options.root);
  const scope = scopeKey(options.scope ?? ".");
  const lock = readLock(root);
  if (!lock) throw new UpgradeError(`no ${LOCK_FILE} in ${root}`);
  const lineage = lock.scopes[scope];
  if (!lineage) {
    throw new UpgradeError(`${LOCK_FILE} has no scope "${scope}" (scopes: ${Object.keys(lock.scopes).join(", ") || "none"})`);
  }
  if (lineage.manualSteps.length > 0) {
    throw new UpgradeError(
      `scope "${scope}" has ${lineage.manualSteps.length} open manual step(s) from its last update (${lineage.manualSteps.map((s) => s.path).join(", ")}). Merge them and run \`chant workspace lineage resolve <path>\` first.`,
    );
  }

  let repo: string;
  let head: string;
  try {
    repo = gitOut(root, ["rev-parse", "--show-toplevel"]).trim();
    head = gitOut(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new UpgradeError("chant workspace upgrade stages its change in a git worktree, so the project must be in a git repository with at least one commit");
  }
  const projectRel = relative(repo, root).split(sep).join("/");
  const scopeRepoPath = [projectRel, scope === "." ? "" : scope].filter(Boolean).join("/") || ".";
  const lockRepoPath = [projectRel, LOCK_FILE].filter(Boolean).join("/");
  let lockTracked = true;
  try {
    gitOut(repo, ["ls-files", "--error-unmatch", "--", lockRepoPath]);
  } catch {
    lockTracked = false;
  }
  const dirty = gitOut(repo, ["status", "--porcelain", "--untracked-files=all", "--", scopeRepoPath, lockRepoPath])
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith(`${[projectRel, UPGRADE_DIR].filter(Boolean).join("/")}/`));
  if (dirty.length > 0) {
    throw new UpgradeError(
      `the scope has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ", …" : ""}). Commit or stash them: the upgrade stages from HEAD and applies its patch to the tree.`,
    );
  }

  // 1. Fetch. A directory source has no ref: `--to` names the directory.
  const fromDir = lineage.source.type === "dir";
  const ref = fromDir ? undefined : options.to ?? lineage.ref;
  const upstream = await fetchUpstream(root, lineage, fromDir ? options.to : ref);

  // 2. The merge base, offline from here on.
  const base = rebuildBase(join(root, scope), lineage, upstream.base);

  // Plan the chain before anything is staged, so a gap refuses early.
  const plan = lineage.kind === "template" ? planMigrations(lineage, ref, upstream.migrations) : { chain: [] };
  assertCodeAllowed(plan.chain, !!options.allowCode);

  // 3. The worktree, inside the project so the project's packages resolve.
  const holder = join(root, UPGRADE_DIR);
  mkdirSync(holder, { recursive: true });
  const worktree = mkdtempSync(join(holder, `${scope === "." ? "root" : basename(scope)}-`));
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      gitOut(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      // Fall through to the directory removal and a prune.
    }
    rmSync(worktree, { recursive: true, force: true });
    try {
      gitOut(repo, ["worktree", "prune"]);
    } catch {
      // Nothing to prune.
    }
    if (existsSync(holder) && readdirSync(holder).length === 0) rmSync(holder, { recursive: true, force: true });
  };

  try {
    gitOut(repo, ["worktree", "add", "-q", "--detach", worktree, head]);
    const worktreeProject = projectRel ? join(worktree, projectRel) : worktree;
    const scopeDir = join(worktreeProject, scope);
    const next = structuredClone(lock) as LineageLock;
    const staged = next.scopes[scope];
    const scratch = mkdtempSync(join(tmpdir(), "chant-upgrade-code-"));
    try {
      for (const m of plan.chain) {
        await runMigration(m, {
          dir: scopeDir,
          lineage: staged,
          modules: upstream.modules,
          allowCode: !!options.allowCode,
          scratch,
          onMove: (from, to) => {
            const data = base.get(from);
            base.delete(from);
            if (data) base.set(to, data);
          },
        });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    // 4. Merge per file.
    const result = applyUpstream(scopeDir, staged, upstream.files, { base, merge: mergeFile });
    for (const path of result.written) if (upstream.executable.has(path)) chmodSync(join(scopeDir, path), 0o755);
    if (ref !== undefined) staged.ref = ref;
    if (upstream.parameters) staged.parameters = upstream.parameters;
    if (upstream.repinned) {
      // The records this version re-pins, among the files the scope keeps (#2549).
      const kept = upstream.repinned.filter((r) => staged.files[r.record] !== undefined || existsSync(join(scopeDir, r.record)));
      if (kept.length > 0) staged.repinned = kept;
      else delete staged.repinned;
    }
    if (upstream.commit) staged.address = { ...staged.address!, commit: upstream.commit, tree: upstream.tree };
    if (upstream.source) staged.source = upstream.source;
    writeLock(worktreeProject, next);
    const lockText = renderLock(next);

    // The patch, taken before anything else runs in the worktree.
    gitOut(worktree, ["add", "-A"]);
    if (!lockTracked) gitOut(worktree, ["rm", "--cached", "-q", "--ignore-unmatch", "--", lockRepoPath]);
    const patch = gitOut(worktree, ["diff", "--cached", "--binary", "--full-index", "--no-color", "--no-ext-diff", head]);
    const changedPaths = gitOut(worktree, ["diff", "--cached", "--name-only", "-z", head]).split("\0").filter(Boolean).sort();
    const lockChanged = !lockTracked && lockText !== readFileSync(join(root, LOCK_FILE), "utf-8");
    const changed = patch.length > 0 || lockChanged;
    const digest = computePlanDigest(UPGRADE_PLAN_KIND, lockTracked ? { scope, patch } : { scope, patch, lock: lockText });

    // Governance: decided by the rules at HEAD, never by the upgraded files.
    const governed = changedPaths.filter(isGovernancePath);
    let governance: GovernanceChange | null = null;
    if (governed.length > 0) {
      const existing = governed.filter((p) => existsSync(join(repo, p)));
      const touched = existing.length === 0 ? [] : gitOut(repo, ["status", "--porcelain", "--", ...existing]).split("\n").filter(Boolean);
      if (touched.length > 0) {
        throw new UpgradeError(`the upgrade changes governance files that have uncommitted edits (${touched.map((l) => l.slice(3)).join(", ")}). Commit them first: their gates are read at HEAD.`);
      }
      governance = { paths: governed, approval: await rulesAtHead(root, repo, governed), rules: head };
    }

    // 5. Checks.
    const checks: UpgradeCheck[] = [];
    if (changed) {
      if (isChantProject(worktreeProject)) {
        const run = options.runChant ?? spawnChant;
        for (const command of ["build", "lint"] as const) {
          const r = await run(command, worktreeProject);
          checks.push(r.exitCode === 0 ? { name: command, status: "passed" } : { name: command, status: "failed", detail: tail(r.output) });
        }
      } else {
        for (const name of ["build", "lint"] as const) checks.push({ name, status: "skipped", detail: "not a chant project (no chant.config)" });
      }
      checks.push(lineageCheck(root, worktreeProject, result.manualSteps, scope));
    }

    return {
      scope,
      template: lineage.template,
      kind: lineage.kind,
      from: fromDir ? sourcePin(lineage.source) : lineage.ref ?? null,
      to: fromDir ? sourcePin(staged.source) : staged.ref ?? null,
      ...(upstream.commit ? { commit: { ...(lineage.address?.commit ? { from: lineage.address.commit } : {}), to: upstream.commit } } : {}),
      migrations: plan.chain.map((m) => m.migration.id),
      written: result.written,
      merged: result.merged,
      removed: result.removed,
      kept: result.kept,
      skipped: result.skipped,
      manualSteps: result.manualSteps,
      changedPaths,
      patch,
      lock: { path: lockRepoPath, tracked: lockTracked, text: lockText },
      changed,
      digest,
      governance,
      checks,
      checksOk: checks.every((c) => c.status !== "failed"),
      repo,
      head,
      worktree,
      worktreeProject,
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** A directory source's pin, for the summary: the directory it reads. */
function sourcePin(source: LineageSource): string | null {
  return source.type === "dir" ? dirLabel(source.path, source.member) : null;
}

/**
 * `chant workspace check` in the worktree. A finding already present at HEAD
 * is not the upgrade's doing, and the upgrade's own manual steps are what the
 * gate approves; any other finding fails the check.
 */
function lineageCheck(root: string, worktreeProject: string, ownSteps: ManualStep[], scope: string): UpgradeCheck {
  const before = new Set(checkLineage(root).findings.map(findingKey));
  const own = new Set(ownSteps.map((s) => (scope === "." ? s.path : `${scope}/${s.path}`)));
  const report = checkLineage(worktreeProject);
  const fresh = report.findings.filter(
    (f: CheckFinding) => !before.has(findingKey(f)) && !(f.code === "manual-step-open" && f.path !== undefined && own.has(f.path)),
  );
  if (fresh.length === 0) return { name: "workspace check", status: "passed" };
  return { name: "workspace check", status: "failed", detail: fresh.map((f) => `${f.path ?? f.scope ?? ""}: ${f.message}`).join("\n") };
}

// ── Apply or propose ─────────────────────────────────────────────────────────

/** Apply the staged patch to the project's tree. Leaves it uncommitted. */
export function applyStagedUpgrade(staged: StagedUpgrade): void {
  if (!staged.lock.tracked) writeFileSync(join(staged.repo, staged.lock.path), staged.lock.text);
  if (!staged.patch) return;
  const file = join(mkdtempSync(join(tmpdir(), "chant-upgrade-patch-")), "upgrade.patch");
  try {
    writeFileSync(file, staged.patch);
    execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", file], { cwd: staged.repo, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new UpgradeError(`the approved patch no longer applies to the tree${stderr ? `: ${stderr}` : ""}`);
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
}

/**
 * Commit the staged patch in the worktree and point `branch` at it. Returns
 * the commit. The caller has already refused the default branch.
 */
export function commitStagedUpgrade(staged: StagedUpgrade, branch: string, message: string): string {
  const identity: string[] = [];
  const has = (key: string): boolean => {
    try {
      return gitOut(staged.worktree, ["config", key]).trim().length > 0;
    } catch {
      return false;
    }
  };
  if (!has("user.name")) identity.push("-c", "user.name=chant");
  if (!has("user.email")) identity.push("-c", "user.email=chant@localhost");
  // An ignored lock is still part of the proposal: the branch starts tracking it.
  if (!staged.lock.tracked) gitOut(staged.worktree, ["add", "-f", "--", staged.lock.path]);
  gitOut(staged.worktree, [...identity, "commit", "-q", "--no-verify", "-m", message]);
  const commit = gitOut(staged.worktree, ["rev-parse", "HEAD"]).trim();
  gitOut(staged.repo, ["branch", "-f", branch, commit]);
  return commit;
}

/** One line per staged change, for the terminal and for a PR body. */
export function describeStaged(staged: StagedUpgrade): string[] {
  const lines: string[] = [];
  const at = (p: string) => (staged.scope === "." ? p : `${staged.scope}/${p}`);
  lines.push(`${staged.scope}  ${staged.template}  ${staged.from ?? "(no ref)"} -> ${staged.to ?? "(no ref)"}`);
  for (const id of staged.migrations) lines.push(`  migration: ${id}`);
  for (const p of staged.written) lines.push(`  updated: ${at(p)}`);
  for (const p of staged.merged) lines.push(`  merged: ${at(p)}`);
  for (const p of staged.removed) lines.push(`  removed: ${at(p)}`);
  for (const s of staged.skipped) {
    if (s.class === "generated") lines.push(`  generated, not merged: ${at(s.path)}${s.command ? ` (rebuild with ${s.command})` : ""}`);
  }
  for (const s of staged.manualSteps) lines.push(`  manual step: ${at(s.path)} (${s.reason})`);
  if (staged.governance) {
    const q = staged.governance.approval.quorum!;
    lines.push(
      `  governance: ${staged.governance.paths.join(", ")}; needs ${q.count} human approval(s)${q.roles ? ` with a role in ${q.roles.join(", ")}` : ""}, from the rules at ${staged.governance.rules.slice(0, 12)}`,
    );
  }
  for (const c of staged.checks) lines.push(`  ${c.name}: ${c.status}${c.status === "skipped" && c.detail ? ` (${c.detail})` : ""}`);
  lines.push(`  patch: ${staged.changedPaths.length} file(s)${staged.lock.tracked ? "" : ` and the untracked ${LOCK_FILE}`}, ${staged.digest}`);
  return lines;
}
