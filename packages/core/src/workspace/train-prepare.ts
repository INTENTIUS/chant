/**
 * Preparing a checkout to publish a release train (#5154): `chant workspace
 * train prepare <env> [<train id|digest>] [--json]`, run in a checkout of the
 * commit the train's new releases were cut from, before `chant workspace
 * train publish`.
 *
 * For each member the train cut from this commit:
 *
 * - its `release.version` files take the member's label, and under `ranges:
 *   "train"` each workspace dependency's range takes `^` and the label the
 *   train gives the member that owns it (what `chant release stamp <label>
 *   --train <id>` does for one member). The publish takes each such file as
 *   the commit's.
 * - the workspace packages it depends on, directly or not, that this run
 *   does not publish are built once each, dependencies first, so a package
 *   that builds against another's output finds it. The members this run
 *   publishes build when npm packs them, in the train's layer order. The
 *   command is `release.train.buildDependencies`, else the package's
 *   `prepack` script, else its `build` script.
 *
 * A workspace package here is one a `chant` member of the train's workspace
 * names in its `release.version.packages` or as a directory of an `npm`
 * target; its dependencies are its `dependencies`, `peerDependencies` and
 * `optionalDependencies` that name another such package.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { resolve } from "node:path";
import { readDeclaration } from "./declaration";
import { findTrain, readReleaseTrains, type ReadTrain } from "./release-train";
import { TrainCutError, trainConfigAt } from "./train-cut";
import { locateWorkspace } from "./which-chant";

export interface TrainPrepareQuery {
  cwd: string;
  env: string;
  /** The train by id or digest; the newest for `env` when absent. */
  train?: string;
  /** Runs one build command in a package directory and returns its exit code. Default: `sh -c`. */
  run?: (command: string, cwd: string) => number;
  say?: (line: string) => void;
}

export interface TrainPrepareOutcome {
  train: ReadTrain;
  /** Each member stamped here, with its label and the files stamped (relative to the member). */
  stamped: Array<{ member: string; label: string; files: string[] }>;
  /** The package directories built, from the workspace root, in the order they were built. */
  built: Array<{ dir: string; command: string }>;
}

interface WorkspacePackage {
  dir: string;
  name: string;
  needs: string[];
  scripts: Record<string, unknown>;
}

const defaultRun = (command: string, cwd: string): number => spawnSync("sh", ["-c", command], { cwd, stdio: ["ignore", "inherit", "inherit"] }).status ?? 1;

/** Stamp and build what the train's members cut from this commit need before `train publish` (#5154). */
export async function prepareTrain(q: TrainPrepareQuery): Promise<TrainPrepareOutcome> {
  const located = locateWorkspace(q.cwd);
  const root = located.rootOnDisk;
  const config = await trainConfigAt(root, q.env);
  const say = q.say ?? (() => undefined);
  const train = findTrain((await readReleaseTrains(root, q.env)).records, q.train);
  if (!train) throw new TrainCutError("train-unknown", q.train ? `no release train ${q.train} is recorded for ${q.env}` : `no release train is recorded for ${q.env}`, `List them with chant workspace train list ${q.env}.`);
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new TrainCutError("not-a-git-repository", "a train is prepared in a checkout of its commit, and this directory is not in a git repository");
  }
  const members = readDeclaration(located.tree, "", { rootChant: true }).members.filter((m) => m.kind === "chant" && m.dir !== ".");
  const here = train.members.filter((m) => m.commit === head);
  if (here.length === 0) throw new TrainCutError("train-nothing-cut-here", `release train ${train.id} has no release cut from this checkout's commit ${head.slice(0, 12)}`, "Check out the commit the train's release-train tag names.");

  const { loadChantConfig } = await import("../config");
  const { stampReleaseVersion } = await import("../lifecycle/release-version");
  const { trainPackageLabels } = await import("./train-range-labels");
  const labels = await trainPackageLabels(train, root);

  // Every workspace package the members name, by name.
  const packages = new Map<string, WorkspacePackage>();
  const ownedBy = new Map<string, string[]>();
  for (const m of members) {
    const dir = resolve(root, m.dir);
    if (!existsSync(dir)) continue;
    const release = (await loadChantConfig(dir)).config.release;
    const dirs = [...(release?.version?.packages ?? []), ...(release?.publish ?? []).flatMap((t) => (t.type === "npm" ? ((t as { packages?: string[] }).packages ?? []) : []))];
    for (const p of dirs) {
      const file = resolve(dir, p, "package.json");
      if (!existsSync(file)) continue;
      const abs = realpathSync(resolve(dir, p));
      let pkg: { name?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; scripts?: Record<string, unknown> };
      try {
        pkg = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        continue;
      }
      if (typeof pkg.name !== "string") continue;
      packages.set(pkg.name, { dir: abs, name: pkg.name, needs: Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }), scripts: pkg.scripts ?? {} });
      ownedBy.set(m.name, [...(ownedBy.get(m.name) ?? []), pkg.name]);
    }
  }

  // The repository's other workspace packages (npm, yarn and pnpm workspaces), which a member's package may build against.
  for (const dir of workspacePackageDirs(located.top ?? root)) {
    try {
      const p = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as { name?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; scripts?: Record<string, unknown> };
      if (typeof p.name !== "string" || packages.has(p.name)) continue;
      packages.set(p.name, { dir: realpathSync(dir), name: p.name, needs: Object.keys({ ...p.dependencies, ...p.peerDependencies, ...p.optionalDependencies }), scripts: p.scripts ?? {} });
    } catch {
      // Not a package chant can read; nothing builds against it.
    }
  }

  // Stamp each member cut here.
  const stamped: TrainPrepareOutcome["stamped"] = [];
  for (const t of here) {
    const m = members.find((x) => x.name === t.member);
    if (!m) continue;
    const dir = resolve(root, m.dir);
    const version = (await loadChantConfig(dir)).config.release?.version;
    if (!version) continue;
    if (t.label === null) throw new TrainCutError("train-member-unlabelled", `release train ${train.id} pins ${t.member} at a release with no label, which has no version to stamp`);
    const { ReleaseVersionError } = await import("../lifecycle/release-version");
    try {
      const s = stampReleaseVersion({ cwd: dir, config: version, label: t.label, train: labels });
      stamped.push({ member: t.member, label: t.label, files: s.files });
      say(`stamped ${t.member} ${t.label}: ${s.files.join(", ")}`);
    } catch (err) {
      if (err instanceof ReleaseVersionError) throw new TrainCutError(err.code, `${t.member}: ${err.message}`, err.fix);
      throw err;
    }
  }

  // Build, once each and dependencies first, the packages the published ones need and this run does not publish.
  const built: TrainPrepareOutcome["built"] = [];
  if (config.buildDependencies !== false) {
    const published = new Set(here.flatMap((t) => ownedBy.get(t.member) ?? []));
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      for (const d of [...(packages.get(name)?.needs ?? [])].sort()) {
        if (d === name || !packages.has(d) || seen.has(d)) continue;
        seen.add(d);
        visit(d);
        order.push(d);
      }
    };
    for (const name of [...published].sort()) visit(name);
    for (const name of order.filter((n) => !published.has(n))) {
      const p = packages.get(name)!;
      const command = config.buildDependencies ?? (typeof p.scripts.prepack === "string" ? "npm run prepack" : typeof p.scripts.build === "string" ? "npm run build" : null);
      if (command === null) continue;
      const shown = p.dir.startsWith(`${realpathSync(located.top ?? root)}/`) ? p.dir.slice(realpathSync(located.top ?? root).length + 1) : p.dir;
      say(`build ${name} (${shown}), which ${[...published].filter((x) => dependsOn(packages, x, name)).join(", ")} builds against: ${command}`);
      const code = (q.run ?? defaultRun)(command, p.dir);
      if (code !== 0) throw new TrainCutError("train-build-failed", `building ${name} in ${shown} failed (exit ${code}): ${command}`, "Fix the build and run the prepare again in a clean checkout of the train's commit.");
      built.push({ dir: shown, command });
    }
  }
  return { train, stamped, built };
}

/**
 * The package directories the repository's root declares as workspaces:
 * `workspaces` in its package.json (an array, or `{ packages }` as yarn
 * writes it) and `packages:` in pnpm-workspace.yaml. A pattern is matched
 * against directories up to four levels deep, leaving out node_modules and
 * dot directories; a `!` pattern excludes.
 */
export function workspacePackageDirs(top: string): string[] {
  const patterns: string[] = [];
  try {
    const w = (JSON.parse(readFileSync(resolve(top, "package.json"), "utf-8")) as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(w) ? w : w && typeof w === "object" && Array.isArray((w as { packages?: unknown }).packages) ? (w as { packages: unknown[] }).packages : [];
    patterns.push(...list.filter((p): p is string => typeof p === "string"));
  } catch {
    // No package.json, or not JSON.
  }
  try {
    const yaml = readFileSync(resolve(top, "pnpm-workspace.yaml"), "utf-8");
    let inPackages = false;
    for (const line of yaml.split("\n")) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line) : null;
      if (m) patterns.push(m[1]!);
    }
  } catch {
    // No pnpm-workspace.yaml.
  }
  if (patterns.length === 0) return [];
  const include = patterns.filter((p) => !p.startsWith("!")).map((p) => picomatch(p.replace(/^\.\//, "").replace(/\/$/, "")) as (s: string) => boolean);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => picomatch(p.slice(1).replace(/^\.\//, "").replace(/\/$/, "")) as (s: string) => boolean);
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(resolve(top, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (include.some((m) => m(sub)) && !exclude.some((m) => m(sub)) && existsSync(resolve(top, sub, "package.json"))) out.push(resolve(top, sub));
      walk(sub, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

/** Whether `from` needs `to`, directly or not, among `packages`. */
function dependsOn(packages: ReadonlyMap<string, WorkspacePackage>, from: string, to: string, seen = new Set<string>()): boolean {
  for (const d of packages.get(from)?.needs ?? []) {
    if (d === to) return true;
    if (seen.has(d) || !packages.has(d)) continue;
    seen.add(d);
    if (dependsOn(packages, d, to, seen)) return true;
  }
  return false;
}

const PREPARE_USAGE = "chant workspace train prepare <env> [<train id|digest>] [--json]";

/** `chant workspace train prepare <env> [<train>]` (#5154). */
export async function runTrainPrepare(ctx: import("../cli/registry").CommandContext, words: string[]): Promise<number> {
  const { formatError, formatSuccess } = await import("../cli/format");
  const { WorkspaceReadError } = await import("./declaration");
  const [env, ref] = words;
  if (!env) {
    console.error(formatError({ message: "chant workspace train prepare needs an environment", hint: PREPARE_USAGE }));
    return 1;
  }
  const json = ctx.args.json === true;
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  let outcome: TrainPrepareOutcome;
  try {
    outcome = await prepareTrain({ cwd, env, ...(ref !== undefined ? { train: ref } : {}), say: (line) => (json ? undefined : console.error(line)) });
  } catch (err) {
    if (err instanceof TrainCutError) {
      if (json) console.log(JSON.stringify({ status: "refused", code: err.code, message: err.message }, null, 2));
      console.error(formatError({ message: `${err.message} [${err.code}]`, hint: err.fix ?? PREPARE_USAGE }));
      return 1;
    }
    if (err instanceof WorkspaceReadError) {
      console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: PREPARE_USAGE }));
      return 1;
    }
    throw err;
  }
  if (json) {
    console.log(JSON.stringify({ train: outcome.train.id, trainDigest: outcome.train.trainDigest, env, stamped: outcome.stamped, built: outcome.built }, null, 2));
    return 0;
  }
  console.error(formatSuccess(`Prepared release train ${outcome.train.id}: ${outcome.stamped.length} member(s) stamped, ${outcome.built.length} dependency package(s) built. Next: chant workspace train publish ${env} ${outcome.train.id} --yes`));
  return 0;
}
