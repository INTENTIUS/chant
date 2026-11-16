/**
 * `chant release init` (#5160): the first setup of `chant release` in a
 * project that has never used chant.
 *
 * It reads the project ({@link detectProject}): the package.json and its
 * npm, pnpm or yarn workspaces, go.mod, Cargo.toml, pyproject.toml,
 * Dockerfiles, a goreleaser config, Helm charts and an nfpm config (#5233),
 * the forge `origin` names, and the tags
 * releases were made under so far. From that it plans a `release` block
 * ({@link planRelease}): the tag template, `legacyTags`, the green gate, the
 * version stamping, the publish targets it can infer, and a dispatched
 * release workflow. Then it writes that block into `chant.config.ts`
 * ({@link insertReleaseBlock}), making a config of the block alone when
 * there is none.
 *
 * Detection reads files and local git only; it never reaches a registry or
 * the forge. Everything it can't set up from the repository, such as an npm
 * trusted publisher, is a step printed for a person ({@link ReleaseInitPlan.registry}).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import { GENERATED_MARKER } from "../discovery/files";
import { forgeOfRemote } from "../forge-remote";

export type ReleaseInitCode =
  | "release-init-release-exists"
  | "release-init-config-unreadable"
  | "release-init-workflow-exists"
  | "release-init-not-a-project"
  | "release-init-member-exists"
  | "release-init-tsx-missing";

/** A refusal of `chant release init`, with its code. */
export class ReleaseInitError extends Error {
  constructor(
    readonly code: ReleaseInitCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseInitError";
  }
}

/** One package.json found in the project. */
export interface InitPackage {
  /** Directory from the project root, `.` for the root. */
  dir: string;
  name: string | null;
  private: boolean;
  /** `publishConfig.access`, when set. */
  access: string | null;
  /** A VS Code extension: `engines.vscode` is set. */
  vscode: boolean;
  /** The extension's publisher, for a VS Code extension. */
  publisher: string | null;
  /** Names in `dependencies`, `peerDependencies` and `optionalDependencies`. */
  deps: string[];
  scripts: string[];
  /** `files` in package.json or an `.npmignore`, so npm packs only what they name. */
  packList?: boolean;
}

export type NodeManager = "npm" | "pnpm" | "yarn";

/** What {@link detectProject} found. */
export interface ProjectFacts {
  /** The project's directory from the repository root, or null at the root. */
  path: string | null;
  /** The forge `origin` names, or null. */
  origin: { kind: "github" | "gitlab" | "forgejo"; host: string; repo: string } | null;
  /** The forge whose workflow directory the repository has, else the origin's, else github. */
  workflowForge: "github" | "gitlab" | "forgejo";
  /** Other CI files at the repository root, which give a commit checks: workflow files other than chant's release, or `.gitlab-ci.yml`. */
  ciFiles: string[];
  /**
   * Workflow files under `.github/workflows` that chant did not write and that
   * run `npm publish` (or pnpm's or yarn's), for this project: an npm trusted
   * publisher names one such file, so the release workflow takes its place.
   */
  publishWorkflows?: string[];
  node: {
    manager: NodeManager;
    lockfile: string | null;
    /** `.yarnrc.yml` is there: yarn 2 or later. */
    yarnBerry: boolean;
    root: InitPackage;
    /** Workspace packages, when the root declares workspaces. */
    workspaces: InitPackage[] | null;
    /** `@intentius/chant` is a dependency of the root package. */
    hasChant: boolean;
  } | null;
  go: { module: string | null } | null;
  rust: {
    name: string | null;
    workspace: boolean;
    /** `Cargo.toml` has a `version` string in `[package]` or `[workspace.package]`, which `release.version.files` can stamp. */
    version: boolean;
    /** `[package]` sets `publish = false`. */
    unpublishable: boolean;
  } | null;
  python: {
    name: string | null;
    /** There is a `pyproject.toml`, which `python -m build` reads. */
    pyproject: boolean;
    /** `pyproject.toml` has a static `version` in `[project]` or `[tool.poetry]`, which `release.version.files` can stamp. */
    version: boolean;
  } | null;
  /** Dockerfiles, from the project root. */
  dockerfiles: string[];
  goreleaser: {
    file: string;
    /** The config sets `snapshot.version_template` to the release label. */
    labelTemplate: boolean;
    /** The config has a top-level `snapshot:` key. */
    snapshot: boolean;
    /** The config builds images (`dockers:` or `kos:`). */
    images: boolean;
  } | null;
  /** Helm charts (#5233): each directory holding a `Chart.yaml`, from the project root, and the chart's name. A chart inside another's directory is its subchart and is not listed. */
  charts?: Array<{ dir: string; name: string | null }>;
  /** An nfpm config (#5233), and whether its `version` follows the label chant passes. */
  nfpm?: { file: string; version: boolean } | null;
  /** The tags releases were made under. */
  tags: TagHistory;
  /** `ci.green` is declared or `ci/green/` tags exist. */
  chantCi: boolean;
  /** `.gitignore` ignores `dist/`. */
  distIgnored: boolean;
}

/** The release tags a repository holds, grouped by what comes before the version. */
export interface TagHistory {
  /** The prefix most of the version tags share, such as `v` or `cli-v`; `""` for bare versions; null with no version tags. */
  prefix: string | null;
  /** How many tags have that prefix. */
  count: number;
  /** The newest tag with that prefix, by version. */
  newest: string | null;
  /** Other prefixes seen, with their counts. */
  others: Array<{ prefix: string; count: number }>;
}

const VERSION_TAG = /^(.*?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
/** The characters a `release.tag` template may hold around its placeholder. */
const TEMPLATE_PREFIX = /^[A-Za-z0-9._+/-]*$/;

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  // A release sorts after its prereleases.
  const ra = a.includes("-") ? 0 : 1;
  const rb = b.includes("-") ? 0 : 1;
  return ra - rb;
}

/**
 * The tag history of a list of tags: version tags grouped by their prefix,
 * the largest group first. `ci/` and `chant/` tags are chant's own and
 * left out.
 */
export function readTagHistory(tags: readonly string[]): TagHistory {
  const groups = new Map<string, string[]>();
  for (const t of tags) {
    if (t.startsWith("ci/") || t.startsWith("chant/")) continue;
    const m = VERSION_TAG.exec(t);
    if (!m) continue;
    const prefix = m[1]!;
    groups.set(prefix, [...(groups.get(prefix) ?? []), m[2]!]);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return { prefix: null, count: 0, newest: null, others: [] };
  const [prefix, versions] = ranked[0]!;
  const newest = [...versions].sort(compareVersions).pop()!;
  return { prefix, count: versions.length, newest: `${prefix}${newest}`, others: ranked.slice(1).map(([p, v]) => ({ prefix: p, count: v.length })) };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readPackage(root: string, dir: string): InitPackage | null {
  const pkg = readJson(join(root, dir, "package.json"));
  if (!pkg) return null;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const engines = obj(pkg.engines);
  const publishConfig = obj(pkg.publishConfig);
  return {
    dir,
    name: typeof pkg.name === "string" ? pkg.name : null,
    private: pkg.private === true,
    access: typeof publishConfig.access === "string" ? publishConfig.access : null,
    vscode: typeof engines.vscode === "string",
    publisher: typeof pkg.publisher === "string" ? pkg.publisher : null,
    deps: [...new Set([pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((d) => Object.keys(obj(d))))],
    scripts: Object.keys(obj(pkg.scripts)),
    packList: Array.isArray(pkg.files) || existsSync(join(root, dir, ".npmignore")),
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "target", "build", ".venv", "venv"]);

/** The directories a workspace pattern such as `packages/*` or `apps/**` names, from `root`. */
export function expandWorkspacePattern(root: string, pattern: string): string[] {
  const parts = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter((p) => p !== "" && p !== ".");
  let dirs: string[] = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      const abs = join(root, d);
      if (part === "**") {
        const walk = (rel: string, depth: number): void => {
          next.push(rel);
          if (depth === 0) return;
          for (const e of safeReaddir(join(root, rel))) if (isDir(join(root, rel, e)) && !SKIP_DIRS.has(e) && !e.startsWith(".")) walk(rel ? `${rel}/${e}` : e, depth - 1);
        };
        walk(d, 3);
      } else if (part.includes("*")) {
        const re = new RegExp(`^${part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
        for (const e of safeReaddir(abs)) if (re.test(e) && !SKIP_DIRS.has(e) && isDir(join(abs, e))) next.push(d ? `${d}/${e}` : e);
      } else if (isDir(join(abs, part))) {
        next.push(d ? `${d}/${part}` : part);
      }
    }
    dirs = next;
  }
  return [...new Set(dirs)].filter((d) => d !== "").sort();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The workspace patterns of a package.json (`workspaces` as a list or `{ packages }`) or a pnpm-workspace.yaml. */
export function workspacePatterns(root: string): string[] | null {
  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm !== null) {
    const out: string[] = [];
    let inPackages = false;
    for (const line of pnpm.split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line) : null;
      if (m) out.push(m[1]!);
    }
    return out;
  }
  const pkg = readJson(join(root, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((w): w is string => typeof w === "string");
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) return ((ws as { packages: unknown[] }).packages).filter((w): w is string => typeof w === "string");
  return null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Dockerfiles at the project root and one or two directories below it, `node_modules` and the like left out. */
function findDockerfiles(root: string): string[] {
  const out: string[] = [];
  const isDockerfile = (n: string) => n === "Dockerfile" || n === "Containerfile";
  const walk = (rel: string, depth: number): void => {
    for (const e of safeReaddir(join(root, rel))) {
      const p = rel ? `${rel}/${e}` : e;
      if (isDockerfile(e) && !isDir(join(root, p))) out.push(p);
      else if (depth > 0 && !SKIP_DIRS.has(e) && !e.startsWith(".") && isDir(join(root, p))) walk(p, depth - 1);
    }
  };
  walk("", 2);
  return out.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Directories holding a `Chart.yaml`, up to three levels down, not looking inside a chart (#5233). */
function findCharts(root: string): Array<{ dir: string; name: string | null }> {
  const out: Array<{ dir: string; name: string | null }> = [];
  const walk = (rel: string, depth: number): void => {
    const here = join(root, rel);
    if (existsSync(join(here, "Chart.yaml")) && !isDir(join(here, "Chart.yaml"))) {
      out.push({ dir: rel || ".", name: /^name:[ \t]*["']?([^"'\s#]+)/m.exec(readText(join(here, "Chart.yaml")) ?? "")?.[1] ?? null });
      return;
    }
    if (depth === 0) return;
    for (const e of safeReaddir(here)) {
      const p = rel ? `${rel}/${e}` : e;
      if (!SKIP_DIRS.has(e) && !e.startsWith(".") && isDir(join(root, p))) walk(p, depth - 1);
    }
  };
  walk("", 3);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The nfpm config files `release init` looks for (#5233). */
const NFPM_FILES = ["nfpm.yaml", "nfpm.yml", ".nfpm.yaml", ".nfpm.yml"];

const GORELEASER_FILES = [".goreleaser.yaml", ".goreleaser.yml", "goreleaser.yaml", "goreleaser.yml"];

/** Whether a goreleaser config sets `snapshot.version_template` to the release label. */
export function goreleaserFacts(text: string): { labelTemplate: boolean; snapshot: boolean; images: boolean } {
  return {
    labelTemplate: /version_template\s*:\s*["']?\{\{\s*\.Env\.CHANT_RELEASE_LABEL\s*\}\}/.test(text),
    snapshot: /^snapshot\s*:/m.test(text),
    images: /^(dockers|dockers_v2|kos)\s*:/m.test(text),
  };
}

/** The lines a goreleaser config needs so its snapshot build carries the release's label. */
export const GORELEASER_SNAPSHOT = 'snapshot:\n  version_template: "{{ .Env.CHANT_RELEASE_LABEL }}"\n';

/** Read the project at `root` (the directory `chant release init` runs in). */
/** The sections of a TOML file by header, each holding its own lines only. */
function tomlSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "";
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(#.*)?$/.exec(line);
    if (h) {
      name = h[1]!;
      continue;
    }
    out.set(name, `${out.get(name) ?? ""}${line}\n`);
  }
  return out;
}

/** A `Cargo.toml`'s name, workspace, stampable version and `publish = false`. */
export function cargoFacts(text: string): NonNullable<ProjectFacts["rust"]> {
  const sections = tomlSections(text);
  const pkg = sections.get("package") ?? "";
  const str = (body: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1] ?? null;
  return {
    name: str(pkg, "name"),
    workspace: sections.has("workspace"),
    version: str(pkg, "version") !== null || str(sections.get("workspace.package") ?? "", "version") !== null,
    unpublishable: /^publish\s*=\s*false\b/m.test(pkg),
  };
}

/** A `pyproject.toml`'s project name, and whether its version is a static string that `release.version.files` can stamp. */
export function pyprojectFacts(text: string): NonNullable<ProjectFacts["python"]> {
  const sections = tomlSections(text);
  const str = (body: string, key: string) => new RegExp(`^${key}\\s*=\\s*["']([^"']*)["']`, "m").exec(body)?.[1] ?? null;
  const project = sections.get("project") ?? "";
  const poetry = sections.get("tool.poetry") ?? "";
  const name = str(project, "name") ?? str(poetry, "name");
  return { name, pyproject: true, version: str(project, "version") !== null || str(poetry, "version") !== null };
}

export function detectProject(root: string): ProjectFacts {
  const top = git(root, ["rev-parse", "--show-toplevel"])?.trim() || root;
  const fromTop = relative(top, root).split(sep).join("/");
  const path = fromTop === "" ? null : fromTop;

  const remote = git(root, ["remote", "get-url", "origin"])?.trim();
  const at = remote ? forgeOfRemote(remote) : undefined;
  const origin = at ? { kind: at.kind, host: at.host, repo: at.repo } : null;
  const workflowForge = isDir(join(top, ".github", "workflows")) ? "github" : isDir(join(top, ".forgejo", "workflows")) ? "forgejo" : existsSync(join(top, ".gitlab-ci.yml")) ? "gitlab" : (origin?.kind ?? "github");
  const ciFiles = [
    ...[".github/workflows", ".forgejo/workflows", ".gitea/workflows"].flatMap((d) =>
      safeReaddir(join(top, d)).filter((f) => /\.ya?ml$/.test(f) && f !== "chant-release.yml").map((f) => `${d}/${f}`),
    ),
    ...(existsSync(join(top, ".gitlab-ci.yml")) ? [".gitlab-ci.yml"] : []),
  ];
  const publishWorkflows = ciFiles.filter((f) => {
    if (!f.startsWith(".github/workflows/")) return false;
    const text = readText(join(top, f));
    if (text === null || text.includes(GENERATED_MARKER) || !NPM_PUBLISH.test(text)) return false;
    // A project below the repository root: only a workflow that names its directory publishes it.
    return path === null || text.includes(path);
  });

  let node: ProjectFacts["node"] = null;
  const rootPkg = readPackage(root, ".");
  if (rootPkg) {
    const lockfile = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"].find((f) => existsSync(join(root, f))) ?? null;
    const manager: NodeManager = existsSync(join(root, "pnpm-lock.yaml")) || existsSync(join(root, "pnpm-workspace.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) || existsSync(join(root, ".yarnrc.yml")) ? "yarn" : "npm";
    const patterns = workspacePatterns(root);
    const workspaces = patterns === null
      ? null
      : [...new Set(patterns.filter((p) => !p.startsWith("!")).flatMap((p) => expandWorkspacePattern(root, p)))]
          .filter((d) => !patterns.some((p) => p.startsWith("!") && expandWorkspacePattern(root, p.slice(1)).includes(d)))
          .map((d) => readPackage(root, d))
          .filter((p): p is InitPackage => p !== null);
    const pkg = readJson(join(root, "package.json"));
    const allDeps = [pkg?.dependencies, pkg?.devDependencies].flatMap((d) => Object.keys(d && typeof d === "object" ? d : {}));
    node = { manager, lockfile, yarnBerry: existsSync(join(root, ".yarnrc.yml")), root: rootPkg, workspaces, hasChant: allDeps.includes("@intentius/chant") };
  }

  const gomod = readText(join(root, "go.mod"));
  const go = gomod === null ? null : { module: /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null };
  const cargo = readText(join(root, "Cargo.toml"));
  const rust = cargo === null ? null : cargoFacts(cargo);
  const pyproject = readText(join(root, "pyproject.toml"));
  const python = pyproject === null ? (existsSync(join(root, "setup.py")) ? { name: null, pyproject: false, version: false } : null) : pyprojectFacts(pyproject);

  const grFile = GORELEASER_FILES.find((f) => existsSync(join(root, f)));
  const goreleaser = grFile ? { file: grFile, ...goreleaserFacts(readText(join(root, grFile)) ?? "") } : null;

  const nfpmFile = NFPM_FILES.find((f) => existsSync(join(root, f)));
  const nfpmVersion = nfpmFile ? /^version:[ \t]*["']?[^\n]*\$\{?CHANT_RELEASE_(VERSION|LABEL)/m.test(readText(join(root, nfpmFile)) ?? "") : false;

  const tagList = (git(top, ["tag", "--list"]) ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
  const chantDecl = readJson(join(root, "chant.workspace.json"));
  const ciGreen = !!(chantDecl?.ci && typeof chantDecl.ci === "object" && (chantDecl.ci as { green?: unknown }).green);
  const gitignore = [readText(join(root, ".gitignore")), path ? readText(join(top, ".gitignore")) : null].filter((t): t is string => t !== null).join("\n");

  return {
    path,
    origin,
    workflowForge,
    ciFiles,
    publishWorkflows,
    node,
    go,
    rust,
    python,
    dockerfiles: findDockerfiles(root),
    goreleaser,
    charts: findCharts(root),
    nfpm: nfpmFile ? { file: nfpmFile, version: nfpmVersion } : null,
    tags: readTagHistory(tagList),
    chantCi: ciGreen || tagList.some((t) => t.startsWith("ci/green/") || /^ci\/green-[^/]+\//.test(t)),
    distIgnored: /^\/?dist\/?\s*$/m.test(gitignore) || /^\/?dist\/\*\s*$/m.test(gitignore),
  };
}

/** A command that publishes to npm: `npm publish`, `pnpm publish`, `yarn publish` or `yarn npm publish`. */
const NPM_PUBLISH = /\b(?:npm|pnpm|yarn(?:\s+npm)?)\s+publish\b/;

/** The default release workflow file for a forge, from the repository root. */
const DEFAULT_WORKFLOW_FILES = { github: ".github/workflows/chant-release.yml", forgejo: ".forgejo/workflows/chant-release.yml", gitlab: ".gitlab/chant-release.yml" } as const;

/**
 * The workflow file a release that publishes to npm runs from: the one
 * workflow under `.github/workflows` that already runs `npm publish`, since
 * the package's npm trusted publisher names that file, else chant's default.
 * Several such files adopt none, and say so in `notes`.
 */
function releaseWorkflowFile(facts: ProjectFacts, publishesNpm: boolean, notes: string[]): { file: string; adopted: boolean } {
  const forge = facts.workflowForge;
  const found = forge === "github" && publishesNpm ? (facts.publishWorkflows ?? []) : [];
  if (found.length === 1) return { file: found[0]!, adopted: true };
  if (found.length > 1) notes.push(`Several workflows run npm publish (${found.join(", ")}), so the release workflow is a new file: set release.workflow.file to the one npm's trusted publisher names to release from it instead.`);
  return { file: DEFAULT_WORKFLOW_FILES[forge], adopted: false };
}

/** A value in the release block, as it is written to chant.config.ts. */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** What `chant release init` would write and say. */
export interface ReleaseInitPlan {
  /** The `release` block. */
  release: Record<string, Json>;
  /** Why each part of the block is what it is, one line each. */
  reasons: string[];
  /** What the release does not publish, and why. */
  notes: string[];
  /** Steps a person takes on the registries and the forge. */
  registry: string[];
  /** The workflow file `chant release workflow` writes, from the repository root. */
  workflowFile: string;
  /** Lines to add to the goreleaser config, when it lacks them. */
  goreleaserPatch: { file: string; append: string | null; manual: string | null } | null;
  /**
   * True when the existing version tags are ones `release.tag` or
   * `release.legacyTags` matches, so `chant release next` reads the newest
   * as the previous release and the first release can take the label `auto`
   * (#5200).
   */
  readsHistory: boolean;
}

/** What the plan needs besides the facts. */
export interface PlanOptions {
  /** The chant version writing the plan, for the workflow's `npx --yes @intentius/chant@<version>`. */
  chantVersion: string;
}

/** Packages in dependency order: each after the packages of the list it depends on, ties by directory. */
export function dependencyOrder(pkgs: readonly InitPackage[]): InitPackage[] {
  const byName = new Map(pkgs.filter((p) => p.name).map((p) => [p.name!, p]));
  const out: InitPackage[] = [];
  const seen = new Set<string>();
  const visit = (p: InitPackage, stack: Set<string>): void => {
    if (seen.has(p.dir) || stack.has(p.dir)) return;
    stack.add(p.dir);
    for (const d of [...p.deps].sort()) {
      const dep = byName.get(d);
      if (dep) visit(dep, stack);
    }
    stack.delete(p.dir);
    seen.add(p.dir);
    out.push(p);
  };
  for (const p of [...pkgs].sort((a, b) => a.dir.localeCompare(b.dir))) visit(p, new Set());
  return out;
}

/** The OCI repository an image is pushed to on the origin's forge registry, or null for a forge without one chant knows. */
function imageRepository(origin: ProjectFacts["origin"], image: string, single: boolean): string | null {
  if (!origin) return null;
  const repo = origin.repo.toLowerCase();
  const suffix = single ? "" : `/${image}`;
  if (origin.kind === "github") return origin.host === "github.com" ? `ghcr.io/${repo}${suffix}` : null;
  if (origin.kind === "gitlab") return origin.host === "gitlab.com" ? `registry.gitlab.com/${repo}${suffix}` : null;
  return `${origin.host}/${repo}${suffix}`;
}

function imageName(dockerfile: string, fallback: string): string {
  const dir = posix.dirname(dockerfile);
  const raw = dir === "." ? fallback : basename(dir);
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "image";
}

/** A tag prefix a `release.tag` template can hold. */
function templatePrefix(prefix: string): boolean {
  return TEMPLATE_PREFIX.test(prefix) && !prefix.startsWith("/") && !prefix.includes("..") && !prefix.includes("//");
}

/**
 * The tag template a project's history asks for, and the prefixes to read
 * older releases by. `packages` is how many packages one release publishes:
 * with more than one, a prefix other than `v` names one package's tags, so
 * the release gets `v{version}` and the older tags are only read.
 */
export function tagTemplateOf(facts: Pick<ProjectFacts, "tags" | "go" | "path">, packages = 1): { template: string; legacy: string[]; reason: string; note: string | null } {
  const h = facts.tags;
  const goSub = facts.go && facts.path;
  const legacy = [h.prefix, ...h.others.map((o) => o.prefix)].filter((p): p is string => p !== null && p !== "" && templatePrefix(p));
  const follows = h.prefix !== null && templatePrefix(h.prefix) && (packages <= 1 || h.prefix === "v" || h.prefix === "");
  if (follows) {
    const template = `${h.prefix}{version}`;
    const goNote = facts.go && h.prefix !== (goSub ? `${facts.path}/v` : "v") ? `The Go module proxy reads ${goSub ? `${facts.path}/v<version>` : "v<version>"} tags, and this repository's are ${h.prefix}<version>.` : null;
    return {
      template,
      legacy,
      reason: `release.tag "${template}": ${h.count} existing tag${h.count === 1 ? "" : "s"} name releases this way, the newest ${h.newest}`,
      note: goNote,
    };
  }
  const template = goSub ? "{path}/v{version}" : "v{version}";
  const why =
    h.prefix === null
      ? "no tag in the repository names a version"
      : !templatePrefix(h.prefix)
        ? `the existing tags (${h.prefix}<version>) hold a character a release.tag template can't`
        : `one release publishes ${packages} packages, and the existing ${h.prefix}<version> tags name one package's releases`;
  return { template, legacy, reason: `release.tag "${template}": ${why}${goSub ? ", and a Go module in a subdirectory is tagged <path>/v<version>" : ""}`, note: null };
}

/** `release.green` for the project, with its reason, and a note when nothing checks its commits. */
function greenOf(facts: ProjectFacts, reasons: string[], notes: string[]): Json {
  reasons.push(facts.chantCi ? 'release.green "chant": chant ci writes ci/green tags here' : 'release.green "forge-checks": a commit may be released when its checks on the forge passed');
  if (!facts.chantCi && facts.ciFiles.length === 0) notes.push("No CI workflow runs on this repository's commits, and a cut refuses a commit with no checks: add CI, or set release.green to \"none\" to release with no gate.");
  return facts.chantCi ? "chant" : "forge-checks";
}

/** The workflow's chant, install and build for a Node project, with their reasons. */
function nodeWorkflow(node: NonNullable<ProjectFacts["node"]>, opts: PlanOptions, workflow: Record<string, Json>, reasons: string[]): void {
  if (!node.hasChant) {
    workflow.chant = `npx --yes @intentius/chant@${opts.chantVersion}`;
    reasons.push(`release.workflow.chant: @intentius/chant is not a dependency here, so the jobs run it from npm at ${opts.chantVersion}`);
  }
  const lockless = node.lockfile === null;
  if (node.manager === "pnpm") workflow.install = "corepack enable && pnpm install --frozen-lockfile";
  else if (node.manager === "yarn") workflow.install = `corepack enable && yarn install ${node.yarnBerry ? "--immutable" : "--frozen-lockfile"}`;
  else if (lockless) workflow.install = "npm install";
  if (workflow.install) reasons.push(`release.workflow.install: ${node.manager === "npm" ? "there is no package-lock.json for npm ci" : `the lockfile is ${node.manager}'s`}`);
  if (node.manager !== "npm" && node.root.scripts.includes("build")) workflow.build = `${node.manager} run build`;
}

/** Plan the `release` block for a project. */
export function planRelease(facts: ProjectFacts, opts: PlanOptions): ReleaseInitPlan {
  const release: Record<string, Json> = {};
  const reasons: string[] = [];
  const notes: string[] = [];
  const registry: string[] = [];
  const publish: Json[] = [];
  const workflow: Record<string, Json> = { trigger: "dispatch" };
  const forge = facts.workflowForge;

  const node0 = facts.node;
  const publishedCount = node0 ? (node0.workspaces ? [...(node0.root.private ? [] : [node0.root]), ...node0.workspaces] : [node0.root]).filter((p) => p.name && !p.private && !p.vscode).length : 0;
  const { file: workflowFile, adopted } = releaseWorkflowFile(facts, publishedCount > 0, notes);
  const workflowName = posix.basename(workflowFile);
  if (adopted) workflow.file = workflowFile;
  const tag = tagTemplateOf(facts, publishedCount);
  release.tag = tag.template;
  reasons.push(tag.reason);
  if (tag.note) notes.push(tag.note);
  if (tag.legacy.length > 0) {
    release.legacyTags = tag.legacy;
    reasons.push(`release.legacyTags ${JSON.stringify(tag.legacy)}: chant release next and release changed read the newest ${tag.legacy.map((p) => `${p}<version>`).join(" or ")} tag as the last release until chant has cut one`);
  }
  const unread = [facts.tags.prefix, ...facts.tags.others.map((o) => o.prefix)].filter((p): p is string => p !== null && p !== "" && !templatePrefix(p));
  if (unread.length > 0) notes.push(`Tags that no release.tag can make are left as they are: ${unread.slice(0, 5).map((p) => `${p}<version>`).join(", ")}.`);

  release.green = greenOf(facts, reasons, notes);

  // npm packages, and VS Code extensions.
  const node = facts.node;
  if (node) {
    const candidates = node.workspaces ? [...(node.root.private ? [] : [node.root]), ...node.workspaces] : [node.root];
    const named = candidates.filter((p) => p.name);
    const extensions = named.filter((p) => p.vscode && !p.private);
    const packages = dependencyOrder(named.filter((p) => !p.private && !p.vscode));
    const skipped = named.filter((p) => p.private);
    if (packages.length > 0) {
      const dirs = packages.map((p) => p.dir);
      const scopedUnset = packages.filter((p) => p.name!.startsWith("@") && p.access === null);
      const target: Record<string, Json> = { type: "npm", packages: dirs };
      if (scopedUnset.length > 0) target.access = "public";
      publish.push(target);
      reasons.push(`npm target: ${packages.map((p) => p.name).join(", ")}${packages.length > 1 ? ", in dependency order" : ""}${scopedUnset.length > 0 ? `; access "public", since ${scopedUnset.map((p) => p.name).join(", ")} ${scopedUnset.length === 1 ? "is a scoped package" : "are scoped packages"} with no publishConfig.access` : ""}`);
      const names = new Set(packages.map((p) => p.name!));
      const internal = packages.some((p) => p.deps.some((d) => names.has(d)));
      release.version = internal ? { packages: dirs, ranges: "exact" } : { packages: dirs };
      reasons.push(`release.version: the release stamps its label into ${dirs.length === 1 ? "the package's" : "each package's"} package.json, so a release needs no version commit${internal ? '; ranges "exact", so each package depends on the versions released beside it' : ""}`);
      const list = packages.map((p) => p.name).join(", ");
      const one = packages.length === 1;
      registry.push(
        adopted
          ? `npm ${list}: the trusted publisher on npmjs.com that names ${facts.origin?.repo ?? "this repository"} and the workflow file ${workflowName} keeps working, since the release runs from that file; edit it to allow npm dist-tag, since the reveal moves latest.${one ? "" : " A package with no trusted publisher yet needs one naming the same file."}`
          : `npm ${list}: on npmjs.com, add a trusted publisher to ${one ? "the package" : "each package"} for ${forge === "gitlab" ? `GitLab CI/CD naming ${facts.origin?.repo ?? "this project"} and the top-level config .gitlab-ci.yml` : `${forge === "github" ? "GitHub Actions" : "this forge"} naming ${facts.origin?.repo ?? "this repository"} and the workflow file ${workflowName}`}, and allow npm dist-tag, since the reveal moves latest. A package that is not on npm yet needs its first version published by hand before it has settings.`,
      );
    }
    if (skipped.length > 0) notes.push(`Not published, being private: ${skipped.map((p) => p.name).join(", ")}.`);
    for (const ext of extensions) {
      const vsix = `${ext.dir === "." ? "" : `${ext.dir}/`}dist/${ext.name!.replace(/^@[^/]+\//, "")}.vsix`;
      publish.push({ type: "marketplace", marketplace: "vscode", vsix });
      publish.push({ type: "marketplace", marketplace: "openvsx", vsix, auth: "trusted-publishing" });
      reasons.push(`marketplace targets: ${ext.name} is a VS Code extension, published to the VS Code Marketplace and Open VSX from ${vsix}`);
      notes.push(`The build must write ${vsix}, such as with vsce package -o ${vsix}, and the VS Code Marketplace target needs vsce on PATH.`);
      // A GitLab job gets the project's CI/CD variables as they are.
      if (forge !== "gitlab") workflow.env = { ...((workflow.env as Record<string, Json>) ?? {}), VSCE_PAT: "${{ secrets.VSCE_PAT }}" };
      registry.push(`VS Code Marketplace ${ext.publisher ?? "<publisher>"}.${ext.name}: create a personal access token with Marketplace (Manage) scope and store it as the ${forge === "gitlab" ? "masked CI/CD variable" : "repository secret"} VSCE_PAT.`);
      registry.push(`Open VSX ${ext.publisher ?? "<publisher>"}.${ext.name}: create the namespace ${ext.publisher ?? "<publisher>"} once, and add ${facts.origin?.repo ?? "this repository"} with the workflow file ${workflowName} under the extension's trusted publishers at https://open-vsx.org/user-settings/trusted-publishers.`);
    }
    nodeWorkflow(node, opts, workflow, reasons);
  }

  // Images.
  const goreleaserImages = facts.goreleaser?.images ?? false;
  const dockerfiles = goreleaserImages ? [] : facts.dockerfiles;
  if (goreleaserImages && facts.dockerfiles.length > 0) notes.push(`${facts.goreleaser!.file} builds the images, so no Dockerfile is declared in release.images.`);
  const fallbackName = (facts.origin?.repo.split("/").pop() ?? facts.node?.root.name?.replace(/^@[^/]+\//, "") ?? facts.go?.module?.split("/").pop() ?? "app");
  const images: Json[] = [];
  const usedNames = new Set<string>();
  for (const dockerfile of dockerfiles) {
    let name = imageName(dockerfile, fallbackName);
    while (usedNames.has(name)) name = `${name}-${usedNames.size}`;
    usedNames.add(name);
    const dir = posix.dirname(dockerfile);
    images.push(dir === "." ? { name, dockerfile } : { name, dockerfile, context: dir });
    const repository = imageRepository(facts.origin, name, dockerfiles.length === 1);
    if (repository) {
      publish.push({ type: "oci", image: `dist/images/${name}.tar`, repository });
      if (repository.startsWith("ghcr.io/")) registry.push(`${repository}: the workflow pushes with the run's token. The first push makes the package private; make it public in the package's settings if it should be.`);
      else registry.push(`${repository}: set OCI_USERNAME and OCI_PASSWORD for the release workflow, as ${forge === "gitlab" ? "masked CI/CD variables" : "secrets in release.workflow.env"}, with push access to the registry.`);
    } else notes.push(`${dockerfile} is built into release.images as ${name}, and no oci target is declared: origin names no registry chant knows. Add { type: "oci", image: "dist/images/${name}.tar", repository: "<registry>/<name>" }.`);
  }
  if (images.length > 0) {
    release.images = images;
    reasons.push(`release.images: ${dockerfiles.join(", ")} built once at the cut as reproducible OCI archives${publish.some((p) => (p as { type?: string }).type === "oci") ? ", pushed by the oci target" : ""}`);
  }

  // goreleaser.
  let goreleaserPatch: ReleaseInitPlan["goreleaserPatch"] = null;
  if (facts.goreleaser) {
    const gr = facts.goreleaser;
    if (!gr.labelTemplate) {
      goreleaserPatch = gr.snapshot
        ? { file: gr.file, append: null, manual: `Set snapshot.version_template to "{{ .Env.CHANT_RELEASE_LABEL }}" in ${gr.file}, so the snapshot build carries the release's label.` }
        : { file: gr.file, append: GORELEASER_SNAPSHOT, manual: null };
    }
    release.artifacts = [{ name: "goreleaser", goreleaser: {} }];
    reasons.push(`release.artifacts: ${gr.file} builds the binaries and archives once at the cut with goreleaser release --snapshot, and the release records each file`);
    if (facts.origin) {
      publish.push({ type: "forge", forge: facts.origin.kind, repo: facts.origin.repo, assets: ["artifact:goreleaser"], notes: { generate: "forge" } });
      reasons.push(`forge target: the goreleaser files as assets of the ${facts.origin.kind} release ${facts.origin.repo}, with generated notes`);
    } else notes.push(`No forge release is declared for ${gr.file}'s files: origin names no GitHub, GitLab or Forgejo repository.`);
  }

  // #5233: Helm charts, packed at the cut and pushed to the registry beside the images.
  const charts = facts.charts ?? [];
  if (charts.length > 0) {
    const entries = charts.map((c, n) => ({ name: charts.length === 1 ? "chart" : `chart-${(c.name ?? `${n + 1}`).toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`, chart: c.dir }));
    release.artifacts = [...((release.artifacts as Json[] | undefined) ?? []), ...entries.map((e) => ({ name: e.name, helm: { chart: e.chart } }))];
    reasons.push(`release.artifacts: ${charts.map((c) => `${c.dir}/Chart.yaml`.replace(/^\.\//, "")).join(", ")} packed once at the cut, with the chart's version set from the label`);
    const repository = imageRepository(facts.origin, "charts", false);
    if (repository) {
      publish.push({ type: "helm", charts: entries.map((e) => `artifact:${e.name}`), oci: { repository } });
      reasons.push(`helm target: ${charts.length === 1 ? "the chart" : "each chart"} pushed to ${repository}/<chart>, tagged with its version, for helm install oci://${repository}/<chart>`);
      if (repository.startsWith("ghcr.io/")) registry.push(`${repository}: the workflow pushes the charts with the run's token. The first push makes each package private; make it public in the package's settings if it should be.`);
      else registry.push(`${repository}: set OCI_USERNAME and OCI_PASSWORD for the release workflow, as ${forge === "gitlab" ? "masked CI/CD variables" : "secrets in release.workflow.env"}, with push access to the registry.`);
    } else notes.push(`The charts are packed into release.artifacts, and no helm target is declared: origin names no registry chant knows. Add { type: "helm", charts: [${entries.map((e) => `"artifact:${e.name}"`).join(", ")}], oci: { repository: "<registry>/<path>" } }.`);
  }

  // #5233: Linux packages nfpm builds, attached to the forge release.
  if (facts.nfpm) {
    const nf = facts.nfpm;
    release.artifacts = [...((release.artifacts as Json[] | undefined) ?? []), { name: "packages", nfpm: nf.file === "nfpm.yaml" ? {} : { config: nf.file } }];
    reasons.push(`release.artifacts: ${nf.file} packages a deb and an rpm once at the cut with nfpm, and the release records each`);
    notes.push(`${nf.file} packs files the cut must build first: declare the build that writes them in release.artifacts before "packages".`);
    if (!nf.version) notes.push(`Set version: "\${CHANT_RELEASE_VERSION}" in ${nf.file}: the cut refuses a config whose packages would not carry the release's version.`);
    const forgeTarget = publish.find((p) => (p as { type?: string }).type === "forge") as { assets: Json[] } | undefined;
    if (forgeTarget) {
      forgeTarget.assets = [...forgeTarget.assets, "artifact:packages"];
      reasons.push(`forge target: the deb and rpm packages are attached beside the other assets`);
    } else if (facts.origin) {
      publish.push({ type: "forge", forge: facts.origin.kind, repo: facts.origin.repo, assets: ["artifact:packages"], notes: { generate: "forge" } });
      reasons.push(`forge target: the deb and rpm packages as assets of the ${facts.origin.kind} release ${facts.origin.repo}, with generated notes`);
    } else notes.push(`No forge release is declared for ${nf.file}'s packages: origin names no GitHub, GitLab or Forgejo repository.`);
  }

  // Python and Rust packages.
  const versionFiles: string[] = [];
  const trustedRepo = facts.origin?.repo ?? "this repository";
  const trustedFor = (what: string) =>
    forge === "gitlab" ? `GitLab CI/CD naming ${trustedRepo} and the top-level pipeline file .gitlab-ci.yml` : `${what} naming ${trustedRepo} and the workflow file ${workflowName}`;
  const py = facts.python;
  if (py?.pyproject && py.name) {
    const forgejo = forge === "forgejo";
    const entry = { name: "python", build: "python -m pip install build && python -m build", outputs: ["dist/*"] };
    release.artifacts = [...((release.artifacts as Json[] | undefined) ?? []), entry];
    publish.push({ type: "pypi", files: ["artifact:python"], auth: forgejo ? "token" : "trusted-publishing" });
    reasons.push(`release.artifacts: ${py.name} is built once at the cut with python -m build, and the release records the sdist and wheel in dist/`);
    reasons.push(`pypi target: the recorded files of ${py.name}, uploaded to PyPI ${forgejo ? "with the token in PYPI_TOKEN" : "with trusted publishing"}`);
    if (py.version) versionFiles.push("pyproject.toml");
    else notes.push("pyproject.toml has no static version (it is dynamic, or unset), so release.version does not stamp it: the build takes the version from wherever the project sets it.");
    if (forgejo) {
      workflow.env = { ...((workflow.env as Record<string, Json>) ?? {}), PYPI_TOKEN: "${{ secrets.PYPI_TOKEN }}" };
      registry.push(`PyPI ${py.name}: create an API token for the project on pypi.org and store it as the secret PYPI_TOKEN; PyPI has no trusted publisher for this forge.`);
    } else {
      registry.push(
        `PyPI ${py.name}: on pypi.org add a trusted publisher to the project's publishing settings (a pending publisher if the project does not exist yet) for ${trustedFor("GitHub Actions")}.${forge === "github" ? " A GitHub publisher can name an environment; leave it empty, since the workflow runs in none." : ""}`,
      );
    }
  } else if (py) notes.push(`${py.name ?? "The Python package"} is tagged and not published to PyPI: ${py.pyproject ? "pyproject.toml has no [project] name" : "there is no pyproject.toml for python -m build to read"}. Add a pypi target to release.publish when it is.`);
  const rs = facts.rust;
  if (rs && !rs.unpublishable && (rs.name || rs.workspace)) {
    publish.push({ type: "cargo" });
    reasons.push(`cargo target: ${rs.name ?? "the workspace's crates"}${rs.workspace && rs.name ? " and its workspace members" : ""} published with cargo publish, in dependency order`);
    if (rs.version) versionFiles.push("Cargo.toml");
    else notes.push("Cargo.toml has no [package] or [workspace.package] version at the root, so release.version does not stamp it: add the member crates' Cargo.toml files to release.version.files.");
    registry.push(
      `crates.io ${rs.name ?? "each crate"}: ${forge === "github" ? `add a trusted publisher to ${rs.name ? "the crate" : "each crate"} on crates.io for GitHub Actions naming ${trustedRepo} and the workflow file ${workflowName}. A crate's first version can't be published that way: publish it by hand, or store a token that may publish new crates as the secret CARGO_REGISTRY_TOKEN and set CARGO_REGISTRY_TOKEN: "\${{ secrets.CARGO_REGISTRY_TOKEN }}" in release.workflow.env.` : `create an API token that may publish ${rs.name ? "the crate" : "the crates"} and store it as the ${forge === "gitlab" ? "masked CI/CD variable" : "secret"} CARGO_REGISTRY_TOKEN${forge === "gitlab" ? "." : ", and set CARGO_REGISTRY_TOKEN: \"${{ secrets.CARGO_REGISTRY_TOKEN }}\" in release.workflow.env."}`}`,
    );
  } else if (rs) notes.push(`${rs.name ?? "The crate"} is tagged and not published to crates.io: ${rs.unpublishable ? "Cargo.toml sets publish = false" : "Cargo.toml has no [package] name or [workspace]"}.`);
  if (versionFiles.length > 0) {
    const current = (release.version as Record<string, Json> | undefined) ?? {};
    release.version = { ...current, files: versionFiles };
    reasons.push(`release.version.files: the release stamps its label into ${versionFiles.join(" and ")}, so a release needs no version commit`);
  }
  if (facts.go && !facts.goreleaser) reasons.push(`Go module ${facts.go.module ?? ""}: the tag is the release the Go module proxy reads; nothing else is published`.replace("  ", " "));

  if (publish.length > 0) release.publish = publish;
  else notes.push("No publish target was found: the release records the commit and makes its tag. Add targets to release.publish as the project needs them.");

  release.workflow = workflow;
  reasons.push(`release.workflow: a release started by hand with its label from ${workflowFile}, which cuts a green commit and publishes it`);
  if (adopted) reasons.push(`release.workflow.file ${workflowFile}: it runs npm publish today, so the npm trusted publisher that names it keeps working; the release workflow replaces it rather than publishing from a second file`);

  if (!facts.distIgnored && (images.length > 0 || facts.goreleaser || charts.length > 0 || facts.nfpm || publish.some((p) => (p as { type?: string }).type === "pypi") || publish.some((p) => (p as { type?: string }).type === "marketplace"))) notes.push("dist/ is not in .gitignore: the publish refuses a tree with build outputs git does not ignore.");
  if (forge === "gitlab") registry.push(`GitLab: include ${workflowFile} from .gitlab-ci.yml, and store a project access token with write_repository as the masked CI/CD variable CHANT_RELEASE_TOKEN; the cut and publish jobs push with it.`);

  const h = facts.tags.prefix;
  const readsHistory = h !== null && (tag.legacy.includes(h) || tag.template === `${h}{version}`);
  return { release, reasons, notes, registry, workflowFile, goreleaserPatch, readsHistory };
}

/** One member of a planned train: a publishable package, released at its own version from its own `chant.config.ts`. */
export interface TrainMemberPlan {
  /** The member's name in `chant.workspace.json`. */
  name: string;
  /** The package's directory from the project root. */
  dir: string;
  /** The npm package name. */
  package: string;
  /** The member's `release` block. */
  release: Record<string, Json>;
}

/** What `chant release init` writes for a workspace released as a train (#5154). */
export interface ReleaseTrainPlan {
  /** The workspace root's `release` block: `train`, the gate and the workflow. */
  release: Record<string, Json>;
  members: TrainMemberPlan[];
  /** The name for a new `chant.workspace.json`. */
  workspaceName: string;
  reasons: string[];
  notes: string[];
  registry: string[];
  workflowFile: string;
  /** The environment the train is recorded for. */
  env: string;
}

/** The environment a planned train is recorded for. */
export const TRAIN_ENV = "npm";

/**
 * Whether the project's npm, pnpm or yarn workspaces can release as a train:
 * one member per publishable package (#5154). `why` says why a project with
 * several packages gets one release instead, and is null for a project with
 * fewer than two.
 */
export function trainFit(facts: ProjectFacts): { train: true } | { train: false; why: string | null } {
  const node = facts.node;
  if (!node?.workspaces) return { train: false, why: null };
  const published = (p: InitPackage) => p.name !== null && !p.private && !p.vscode;
  const packages = node.workspaces.filter(published);
  const rootPublished = published(node.root);
  if (packages.length + (rootPublished ? 1 : 0) < 2) return { train: false, why: null };
  if (rootPublished) return { train: false, why: `the root package ${node.root.name} is published too, and a train releases the packages below the root` };
  const ext = [node.root, ...node.workspaces].find((p) => p.vscode && !p.private && p.name);
  if (ext) return { train: false, why: `${ext.name} is a VS Code extension, and its .vsix is a file the train workflow does not hand from its cut job to its publish job` };
  if (facts.goreleaser) return { train: false, why: `${facts.goreleaser.file} builds files at the cut, which the train workflow does not hand between its jobs` };
  if (facts.dockerfiles.length > 0) return { train: false, why: `${facts.dockerfiles[0]} is an image built at the cut, which the train workflow does not hand between its jobs` };
  if ((facts.charts?.length ?? 0) > 0) return { train: false, why: `${facts.charts![0]!.dir}/Chart.yaml is a chart packed at the cut, which the train workflow does not hand between its jobs` };
  if (facts.nfpm) return { train: false, why: `${facts.nfpm.file} packages files at the cut, which the train workflow does not hand between its jobs` };
  if (facts.python?.pyproject && facts.python.name) return { train: false, why: "pyproject.toml is built at the cut, which the train workflow does not hand between its jobs" };
  if (facts.rust && !facts.rust.unpublishable && (facts.rust.name || facts.rust.workspace)) return { train: false, why: "Cargo.toml's crates publish beside the npm packages, and a train releases npm packages" };
  if (facts.workflowForge === "gitlab") return { train: false, why: "the train workflow renders for GitHub and Forgejo, and this repository runs GitLab CI" };
  return { train: true };
}

/** A workspace member name (lowercase letters, digits and dashes, at most 40) for a package. */
export function memberNameOf(pkg: Pick<InitPackage, "name" | "dir">): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 40).replace(/-+$/, "");
  return clean(pkg.name?.replace(/^@[^/]+\//, "") ?? "") || clean(posix.basename(pkg.dir)) || "package";
}

/** The tag prefixes of a history that name one package's releases: `core-v`, `core/v`, `@acme/core@`, `packages/core/v`. */
function ownPrefixes(h: TagHistory, pkg: InitPackage, member: string): string[] {
  const names = new Set([pkg.name, pkg.name?.replace(/^@[^/]+\//, ""), member, pkg.dir, posix.basename(pkg.dir)].filter((n): n is string => !!n));
  return [h.prefix, ...h.others.map((o) => o.prefix)].filter((p): p is string => p !== null && p !== "" && names.has(p.replace(/[/@_-]v?$/, "")));
}

/**
 * Plan a train for a project {@link trainFit} accepts: a member per
 * publishable workspace package, each stamping and publishing its own
 * package, and the root's `release.train` with a dispatched workflow.
 */
export function planTrain(facts: ProjectFacts, opts: PlanOptions): ReleaseTrainPlan {
  const node = facts.node!;
  const reasons: string[] = [];
  const notes: string[] = [];
  const registry: string[] = [];
  const forge = facts.workflowForge;
  const { file: workflowFile, adopted } = releaseWorkflowFile(facts, true, notes);
  const workflowName = posix.basename(workflowFile);
  const env = TRAIN_ENV;

  const named = node.workspaces!.filter((p) => p.name);
  const packages = dependencyOrder(named.filter((p) => !p.private && !p.vscode));
  const skipped = named.filter((p) => p.private);
  const names = new Set(packages.map((p) => p.name!));
  const greenReasons: string[] = [];
  const green = greenOf(facts, greenReasons, notes);

  // Member names, unique.
  const used = new Set<string>();
  const memberNames = packages.map((p) => {
    const base = memberNameOf(p);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base.slice(0, 38)}-${i}`;
    used.add(name);
    return name;
  });

  // Tags: a package's own history keeps its prefix; tags shared by every package are the root's legacy tags.
  const h = facts.tags;
  const claimed = new Set<string>();
  const members: TrainMemberPlan[] = packages.map((p, i) => {
    const name = memberNames[i]!;
    const own = ownPrefixes(h, p, name);
    for (const o of own) claimed.add(o);
    const template = own.find(templatePrefix);
    const release: Record<string, Json> = { tag: template ? `${template}{version}` : "{member}/v{version}" };
    const legacy = own.filter((o) => o !== template);
    if (legacy.length > 0) release.legacyTags = legacy;
    release.green = green;
    const internal = p.deps.some((d) => names.has(d) && d !== p.name);
    release.version = internal ? { packages: ["."], ranges: "train" } : { packages: ["."] };
    const target: Record<string, Json> = { type: "npm", packages: ["."] };
    if (p.name!.startsWith("@") && p.access === null) target.access = "public";
    release.publish = [target];
    return { name, dir: p.dir, package: p.name!, release };
  });
  const shared = [h.prefix, ...h.others.map((o) => o.prefix)].filter((p): p is string => p !== null && p !== "" && !claimed.has(p));

  const release: Record<string, Json> = { train: shared.length > 0 ? { env, first: "together" } : { env } };
  reasons.push(
    `release.train: ${packages.length} packages, each a workspace member released at its own version; chant workspace train cut ${env} cuts every member that changed since its last release, and the train publishes them in dependency order${shared.length > 0 ? `. first "together": the packages have shared ${shared.map((p) => `${p}<version>`).join(" and ")} releases, so the first train gives every package one label past the highest version any has, and each later train labels each on its own` : ""}`,
  );
  if (shared.length > 0) {
    release.legacyTags = shared;
    reasons.push(`release.legacyTags ${JSON.stringify(shared)}: chant release changed reads the newest ${shared.map((p) => `${p}<version>`).join(" or ")} tag as every package's last release until the train has cut one`);
  }
  release.green = green;
  reasons.push(...greenReasons);
  const workflow: Record<string, Json> = { trigger: "dispatch" };
  if (adopted) workflow.file = workflowFile;
  nodeWorkflow(node, opts, workflow, reasons);
  release.workflow = workflow;
  reasons.push(`release.workflow: ${workflowFile}, started by hand with the levels, cuts the train from a green commit and publishes it`);
  if (adopted) reasons.push(`release.workflow.file ${workflowFile}: it runs npm publish today, so the npm trusted publishers that name it keep working; the train workflow replaces it rather than publishing from a second file`);

  for (const m of members) {
    const tag = m.release.tag as string;
    const ranges = (m.release.version as { ranges?: string }).ranges;
    const access = ((m.release.publish as Json[])[0] as { access?: string }).access;
    reasons.push(
      `${m.dir}/chant.config.ts, member ${m.name}: ${m.package} stamped with its label and published to npm${access ? ' with access "public"' : ""}, tagged ${tag}${ranges ? `; ranges "train", so its range on a sibling names the version the train gives it` : ""}${m.release.legacyTags ? `; its ${(m.release.legacyTags as string[]).map((p) => `${p}<version>`).join(" and ")} tags read as earlier releases` : ""}`,
    );
  }
  if (skipped.length > 0) notes.push(`Not published, being private: ${skipped.map((p) => p.name).join(", ")}. The train's publish job builds ${skipped.length === 1 ? "it" : "them"} when a member needs ${skipped.length === 1 ? "it" : "them"}.`);
  const packed = packages.filter((p) => !p.packList);
  if (packed.length > 0) notes.push(`npm packs a package's chant.config.ts with it unless package.json files or an .npmignore leaves it out: ${packed.map((p) => p.name).join(", ")} ${packed.length === 1 ? "has" : "have"} neither.`);

  const repo = facts.origin?.repo ?? "this repository";
  for (const m of members) {
    registry.push(
      adopted
        ? `npm ${m.package}: keep the trusted publisher on npmjs.com that names ${repo} and the workflow file ${workflowName}, or add one naming them if the package has none, and allow npm dist-tag on it, since the reveal moves latest. If ${m.package} is not on npm yet, publish its first version by hand from ${m.dir} (npm publish) so it has settings; the train labels the next past it.`
        : `npm ${m.package}: on npmjs.com, add a trusted publisher for ${forge === "github" ? "GitHub Actions" : "this forge"} naming ${repo} and the workflow file ${workflowName}, and allow npm dist-tag, since the reveal moves latest. Every package names the same file. If ${m.package} is not on npm yet, publish its first version by hand from ${m.dir} (npm publish) so it has settings; the train labels the next past it.`,
    );
  }

  const workspaceName = memberNameOf({ name: facts.origin?.repo.split("/").pop() ?? node.root.name ?? null, dir: facts.path ?? "workspace" }) || "workspace";
  return { release, members, workspaceName, reasons, notes, registry, workflowFile, env };
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A value as TypeScript source, objects and arrays on one line when short. */
export function toSource(value: Json, indent: string, step = "  "): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = indent + step;
  if (Array.isArray(value)) {
    const items = value.map((v) => toSource(v, inner, step));
    const flat = `[${items.join(", ")}]`;
    return flat.length + indent.length <= 100 && !flat.includes("\n") ? flat : `[\n${items.map((i) => `${inner}${i},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(value).map(([k, v]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${toSource(v, inner, step)}`);
  if (entries.length === 0) return "{}";
  const flat = `{ ${entries.join(", ")} }`;
  return flat.length + indent.length <= 100 && !flat.includes("\n") ? flat : `{\n${entries.map((e) => `${inner}${e},`).join("\n")}\n${indent}}`;
}

/** The `release:` property as source, at `indent`, expanded one level so each field is on its own line. */
export function releaseBlockSource(release: Record<string, Json>, indent: string, step = "  "): string {
  const inner = indent + step;
  return `release: {\n${Object.entries(release).map(([k, v]) => `${inner}${k}: ${toSource(v, inner, step)},`).join("\n")}\n${indent}}`;
}

/** A config made of the release block alone. */
export function newConfigSource(release: Record<string, Json>): string {
  return `// chant.config.ts: what chant release cuts and publishes. See https://intentius.io/chant/cli/release/\nexport default {\n  ${releaseBlockSource(release, "  ")},\n};\n`;
}

/**
 * Walk TypeScript source from `from`, skipping strings, template literals and
 * comments, and call `visit` at each other character with the brace depth
 * relative to `from`. Stops when `visit` returns true.
 */
function scan(src: string, from: number, visit: (i: number, depth: number) => boolean): void {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) return;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      // The closing quote is visited, so a caller sees where the string ends.
      if (i < src.length && visit(i, depth)) return;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    if (visit(i, depth)) return;
    if (c === "}" || c === "]" || c === ")") depth--;
  }
}

/** Where the object a config's default export is opens, or -1. */
function defaultObjectStart(src: string): number {
  let at = -1;
  scan(src, 0, (i, depth) => {
    if (depth === 0 && src.startsWith("export default", i)) {
      at = i + "export default".length;
      return true;
    }
    return false;
  });
  if (at < 0) return -1;
  const rest = src.slice(at);
  const direct = /^\s*(?:(?:[A-Za-z_$][\w$.]*\s*(?:<[^>]*>)?\s*)?\(\s*)?\{/.exec(rest);
  if (direct) return at + direct[0].length - 1;
  const ident = /^\s*([A-Za-z_$][\w$]*)\s*(?:;|$|\n|satisfies|as)/.exec(rest);
  if (!ident) return -1;
  const decl = new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]+)?=\\s*(?:[A-Za-z_$][\\w$.]*\\s*\\(\\s*)?\\{`).exec(src);
  return decl ? decl.index + decl[0].length - 1 : -1;
}

/** The end (exclusive) of the bracketed value that opens at `open`. */
function closeOf(src: string, open: number): number {
  let end = -1;
  scan(src, open, (i, depth) => {
    if (depth === 1 && i > open && "}])".includes(src[i]!)) {
      end = i + 1;
      return true;
    }
    return false;
  });
  return end;
}

/**
 * Write `release` into a chant.config.ts's default export: before the
 * object's closing brace, or in place of an existing `release` property
 * when `force`. Throws {@link ReleaseInitError}: `release-init-release-exists`
 * for a `release` property without `force`, `release-init-config-unreadable`
 * when the default export is not an object literal this can find.
 */
export function insertReleaseBlock(src: string, release: Record<string, Json>, force: boolean): string {
  const open = defaultObjectStart(src);
  const close = open < 0 ? -1 : closeOf(src, open);
  if (open < 0 || close < 0) {
    throw new ReleaseInitError(
      "release-init-config-unreadable",
      "chant.config.ts has no default export of an object literal to add release to",
      "Add the release block shown here to the config by hand.",
    );
  }
  // The indentation of the object's properties.
  const firstProp = /\n([ \t]+)\S/.exec(src.slice(open, close));
  const lineStart = src.lastIndexOf("\n", open) + 1;
  const outer = /^[ \t]*/.exec(src.slice(lineStart))![0];
  const indent = firstProp ? firstProp[1]! : `${outer}  `;
  const step = indent.length > outer.length ? indent.slice(outer.length) : "  ";
  const block = releaseBlockSource(release, indent, step);

  let keyAt = -1;
  scan(src, open, (i, depth) => {
    if (i >= close) return true;
    if (depth === 1 && /[\s{,]/.test(src[i - 1] ?? "") && /^(?:release|"release"|'release')\s*:/.test(src.slice(i))) {
      keyAt = i;
      return true;
    }
    return false;
  });
  if (keyAt >= 0) {
    if (!force) throw new ReleaseInitError("release-init-release-exists", "chant.config.ts already has a release block", "Run again with --force to replace it, or add the fields shown here to it by hand.");
    const valueAt = keyAt + /^[^:]*:\s*/.exec(src.slice(keyAt))![0].length;
    if (src[valueAt] !== "{") throw new ReleaseInitError("release-init-config-unreadable", "the release property in chant.config.ts is not an object literal", "Replace it with the release block shown here by hand.");
    const end = closeOf(src, valueAt);
    return src.slice(0, keyAt) + block + src.slice(end);
  }
  // Before the closing brace, after the last property, its comma, and a comment on its line.
  const brace = close - 1;
  let last = open;
  scan(src, open, (i) => {
    if (i >= brace) return true;
    if (!/\s/.test(src[i]!)) last = i;
    return false;
  });
  const needsComma = last !== open && src[last] !== ",";
  const lineEnd = src.indexOf("\n", last);
  const tail = lineEnd >= 0 && lineEnd < brace ? lineEnd : last + 1;
  const head = src.slice(0, last + 1) + (needsComma ? "," : "") + src.slice(last + 1, tail).replace(/\s+$/, "");
  return `${head}\n${indent}${block},\n${outer}${src.slice(brace)}`;
}
