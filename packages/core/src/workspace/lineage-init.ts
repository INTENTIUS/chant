/**
 * The lineage lock at init (#2540, ws-047): `chant init --from <repo>@<ref>`
 * and `chant init --template <name>` both leave `.chant/workspace.lock.json`
 * with one lineage, scope `"."`, so a project made from a template can be
 * upgraded later without first running adopt-lineage.
 *
 * `--from` fetches with `git`: the one network step, listed in the egress
 * catalogue (`test/egress-catalogue.ts`). The commit and the tree of the
 * chosen directory become the content address.
 *
 * Plain `chant init` without `--template` writes no lock. That keeps the
 * output of an existing command unchanged (#2525 rule 2), and this module
 * never loads for it.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  LOCK_FILE,
  LockError,
  contentDigest,
  emptyLock,
  fileEntries,
  readLock,
  writeLock,
  type Lineage,
} from "./lineage-lock";
import { MIGRATIONS_DIR } from "./lineage-migrations";

// ── The template spec ────────────────────────────────────────────────────────

export interface TemplateSpec {
  /** The repository as written. */
  repo: string;
  /** What `git fetch` is given: a URL, or an absolute local path. */
  url: string;
  ref: string;
  /** The directory inside the repository to instantiate (`#<member>`). */
  member?: string;
  /** Stable identity: `<host>/<path>` for a remote, the path as written for a local repo, plus `#<member>`. */
  id: string;
}

/**
 * Parse `<repo>@<ref>[#<member>]`. `<repo>` is a git URL, an scp-style
 * `git@host:path`, a local path, or `owner/name` for a GitHub repository.
 */
export function parseTemplateSpec(spec: string, cwd: string = process.cwd()): TemplateSpec {
  let rest = spec.trim();
  let member: string | undefined;
  const hash = rest.lastIndexOf("#");
  if (hash >= 0) {
    member = rest.slice(hash + 1).replace(/^\/+|\/+$/g, "");
    rest = rest.slice(0, hash);
    if (!member || posix.normalize(member).startsWith("..")) throw new LockError(`--from ${spec}: "#${member}" is not a directory in the repository`);
    member = posix.normalize(member);
  }
  const at = rest.lastIndexOf("@");
  const lastSep = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf(":"));
  if (at <= 0 || at < lastSep || at === rest.length - 1) {
    throw new LockError(`--from ${spec}: expected <repo>@<ref>[#<member>], e.g. acme/starter@v1.2.0`);
  }
  const repo = rest.slice(0, at);
  const ref = rest.slice(at + 1);

  let url: string;
  let repoId: string;
  const local = resolve(cwd, repo);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) {
    url = repo;
    repoId = repo.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "").replace(/\.git$/, "");
  } else if (/^[^/@\s]+@[^:\s]+:/.test(repo)) {
    url = repo;
    repoId = repo.replace(/^[^@]+@/, "").replace(":", "/").replace(/\.git$/, "");
  } else if (existsSync(local)) {
    url = local;
    repoId = repo;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    url = `https://github.com/${repo}.git`;
    repoId = `github.com/${repo.replace(/\.git$/, "")}`;
  } else if (/^[\w.-]+\.[a-z]{2,}\/[\w./-]+$/i.test(repo)) {
    url = `https://${repo}${repo.endsWith(".git") ? "" : ".git"}`;
    repoId = repo.replace(/\.git$/, "");
  } else {
    throw new LockError(`--from ${spec}: "${repo}" is not a URL, a local repository or owner/name`);
  }
  return { repo, url, ref, member, id: member ? `${repoId}#${member}` : repoId };
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export interface FetchedTemplate {
  commit: string;
  tree: string;
  /** Files under the chosen directory, relative to it. */
  files: Map<string, { data: Buffer; executable: boolean }>;
  /** Paths that were not copied, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/**
 * Read the files of `member` (or the whole tree) at `commit` from a scratch
 * repository that already holds the commit. Symbolic links, submodules and
 * the template's own lineage lock are skipped, with the reason.
 */
export function readTemplateTree(
  scratch: string,
  commit: string,
  member: string | undefined,
  label: string,
): { tree: string; files: FetchedTemplate["files"]; skipped: FetchedTemplate["skipped"] } {
  let tree: string;
  try {
    tree = git(scratch, ["rev-parse", member ? `${commit}:${member}` : `${commit}^{tree}`]);
    if (git(scratch, ["cat-file", "-t", tree]) !== "tree") throw new Error("not a tree");
  } catch {
    throw new LockError(`${label} has no directory ${member}`);
  }

  const files: FetchedTemplate["files"] = new Map();
  const skipped: FetchedTemplate["skipped"] = [];
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", tree], { cwd: scratch, maxBuffer: 256 * 1024 * 1024 }).toString("utf-8");
  for (const row of listing.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const [mode, type, sha] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (path === LOCK_FILE) {
      skipped.push({ path, reason: "the template's own lineage lock" });
      continue;
    }
    if (type !== "blob") {
      skipped.push({ path, reason: `a ${type === "commit" ? "submodule" : type}` });
      continue;
    }
    if (mode === "120000") {
      skipped.push({ path, reason: "a symbolic link" });
      continue;
    }
    const data = execFileSync("git", ["cat-file", "blob", sha], { cwd: scratch, maxBuffer: 256 * 1024 * 1024 });
    files.set(path, { data, executable: mode === "100755" });
  }
  return { tree, files, skipped };
}

/**
 * Fetch one commit of the template repository into a scratch repository and
 * read the files of the chosen directory from it. The template's own lock is
 * never copied: it describes the template's lineage, not the new project's.
 */
export function fetchTemplate(spec: TemplateSpec): FetchedTemplate {
  const scratch = mkdtempSync(join(tmpdir(), "chant-init-from-"));
  try {
    git(scratch, ["init", "-q"]);
    try {
      // The one network step of `chant init --from`, catalogued in test/egress-catalogue.ts.
      git(scratch, ["fetch", "-q", "--depth", "1", spec.url, spec.ref]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.toString().trim();
      throw new LockError(`could not fetch ${spec.repo}@${spec.ref}${stderr ? `: ${stderr}` : ""}`);
    }
    const commit = git(scratch, ["rev-parse", "FETCH_HEAD^{commit}"]);
    return { commit, ...readTemplateTree(scratch, commit, spec.member, `${spec.repo}@${spec.ref}`) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── init --from ──────────────────────────────────────────────────────────────

export interface InitFromOptions {
  from: string;
  /** Target directory (defaults to cwd). */
  path?: string;
  force?: boolean;
}

export interface InitFromResult {
  success: boolean;
  createdFiles: string[];
  warnings: string[];
  error?: string;
  spec?: TemplateSpec;
  commit?: string;
}

/** `chant init --from <repo>@<ref>[#<member>] [path]`. */
export async function initFromCommand(options: InitFromOptions): Promise<InitFromResult> {
  const targetDir = resolve(options.path ?? ".");
  const warnings: string[] = [];
  const createdFiles: string[] = [];

  let spec: TemplateSpec;
  try {
    spec = parseTemplateSpec(options.from);
  } catch (err) {
    return { success: false, createdFiles, warnings, error: (err as Error).message };
  }

  if (existsSync(targetDir)) {
    const visible = readdirSync(targetDir).filter((f) => !f.startsWith("."));
    if (visible.length > 0 && !options.force) {
      return { success: false, createdFiles, warnings, error: "Directory is not empty. Use --force to initialize anyway." };
    }
    if (visible.length > 0) warnings.push("Initializing in non-empty directory");
  }
  if (existsSync(join(targetDir, LOCK_FILE))) {
    return { success: false, createdFiles, warnings, error: `${LOCK_FILE} already exists; this directory already has a lineage` };
  }

  let fetched: FetchedTemplate;
  try {
    fetched = fetchTemplate(spec);
  } catch (err) {
    return { success: false, createdFiles, warnings, error: (err as Error).message };
  }
  for (const s of fetched.skipped) {
    if (s.path !== LOCK_FILE) warnings.push(`${s.path} is ${s.reason}, not copied`);
  }

  mkdirSync(targetDir, { recursive: true });
  const written = new Map<string, Buffer>();
  for (const [path, file] of [...fetched.files].sort(([a], [b]) => a.localeCompare(b))) {
    // The template's migrations (#2550) are for `chant workspace upgrade`, not part of a project.
    if (path.startsWith(`${MIGRATIONS_DIR}/`)) continue;
    const abs = join(targetDir, path);
    if (existsSync(abs)) {
      warnings.push(`${path} already exists, skipping`);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.data);
    if (file.executable) chmodSync(abs, 0o755);
    written.set(path, file.data);
    createdFiles.push(path);
  }

  const lineage: Lineage = {
    kind: "template",
    template: spec.id,
    source: { type: "git", repo: spec.repo, url: portableUrl(spec.url, targetDir), ...(spec.member ? { path: spec.member } : {}) },
    ref: spec.ref,
    address: { digest: contentDigest(written), commit: fetched.commit, tree: fetched.tree },
    parameters: {},
    migrations: [],
    files: fileEntries(written),
    manualSteps: [],
  };
  const lock = emptyLock();
  lock.scopes["."] = lineage;
  writeLock(targetDir, lock);
  createdFiles.push(LOCK_FILE);

  return { success: true, createdFiles, warnings, spec, commit: fetched.commit };
}

/** A local repository is recorded relative to the project, so the lock does not name this machine's paths. */
function portableUrl(url: string, targetDir: string): string {
  if (!isAbsolute(url)) return url;
  const rel = relative(targetDir, url).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// ── init --template ──────────────────────────────────────────────────────────

/** The installed version of a lexicon package, or null when it cannot be found. */
function lexiconPackageVersion(pkg: string, from: string): string | null {
  for (const base of [join(from, "package.json"), import.meta.url]) {
    try {
      const require = createRequire(base);
      let dir = dirname(require.resolve(pkg));
      for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          const json = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: string; version?: string };
          if (json.name === pkg) return json.version ?? null;
        }
        dir = dirname(dir);
      }
    } catch {
      // Not resolvable from here; try the next base.
    }
  }
  return null;
}

export interface TemplateLockInput {
  targetDir: string;
  lexicon: string;
  template: string;
  /** Files init wrote, relative to `targetDir`. */
  createdFiles: string[];
  chantVersion: string;
  /** Set when the project's config declares the lexicon by path (#2520): the path, recorded instead of a package. */
  lexiconModule?: string;
}

/**
 * Record the lineage of a `chant init --template` project. Only files init
 * actually wrote are listed; a file that already existed was not made from
 * the template. `.chant/types/` is gitignored and left out (D14).
 *
 * Returns the lock's path relative to `targetDir`, or null when the target
 * already has a lock (init never overwrites a lineage).
 */
export function writeTemplateLock(input: TemplateLockInput): string | null {
  if (readLock(input.targetDir)) return null;
  const files = new Map<string, Buffer>();
  for (const rel of input.createdFiles) {
    if (rel.startsWith(".chant/")) continue;
    files.set(rel, readFileSync(join(input.targetDir, rel)));
  }
  const pkg = input.lexiconModule ?? `@intentius/chant-lexicon-${input.lexicon}`;
  const lock = emptyLock();
  lock.scopes["."] = {
    kind: "template",
    template: `lexicon:${input.lexicon}/${input.template}`,
    source: { type: "lexicon", lexicon: input.lexicon, template: input.template },
    address: {
      digest: contentDigest(files),
      package: pkg,
      version: input.lexiconModule ? null : lexiconPackageVersion(pkg, input.targetDir),
      chant: input.chantVersion,
    },
    parameters: {},
    migrations: [],
    files: fileEntries(files),
    manualSteps: [],
  };
  writeLock(input.targetDir, lock);
  return LOCK_FILE;
}
