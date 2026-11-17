/**
 * The toolchains a generated release workflow sets up (#5152), and the
 * per-platform build jobs that run before the cut.
 *
 * A job that runs chant always has Node, since chant runs on it. Beside it
 * the jobs set up what the project builds with: declared in
 * `release.workflow.toolchains`, or found from the files at the project's
 * root (`go.mod`, `pyproject.toml`, `Cargo.toml`, `pom.xml`, ...). Each
 * setup action is pinned by commit in ../action-pins.ts, and none caches:
 * a release build starts from the commit and the toolchain, not from a cache
 * an earlier run could have written.
 */
import { ACTION_PINS, usesRef } from "../action-pins";

export const RELEASE_TOOLCHAINS = ["node", "go", "python", "rust", "java"] as const;
export type ReleaseToolchainName = (typeof RELEASE_TOOLCHAINS)[number];

/** One entry of `release.workflow.toolchains`: a name, or a name with the version to install. */
export type ReleaseToolchainDecl = ReleaseToolchainName | { name: ReleaseToolchainName; version: string };

/** The files at a project's root that say which toolchain it builds with, and which version. */
export const TOOLCHAIN_MARKERS = [
  "package.json",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  ".python-version",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  ".java-version",
  ".sdkmanrc",
  ".tool-versions",
] as const;

const FOUND_BY: Record<ReleaseToolchainName, readonly string[]> = {
  node: ["package.json"],
  go: ["go.mod"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  rust: ["Cargo.toml"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

/** The toolchains the files at a project's root name, in {@link RELEASE_TOOLCHAINS} order. */
export function detectToolchains(files: ReadonlySet<string>): ReleaseToolchainName[] {
  return RELEASE_TOOLCHAINS.filter((t) => FOUND_BY[t].some((f) => files.has(f)));
}

/** A setup step: the pinned action and its inputs. */
export interface ToolchainStep {
  name: ReleaseToolchainName;
  uses: string;
  with: Array<[string, string | number | boolean]>;
}

/** The Node every job that runs chant gets, as the workflow always set it up. */
export const NODE_DEFAULT_VERSION = 24;

/**
 * The setup step for one toolchain. A declared version wins; otherwise the
 * version file the project keeps (`go.mod`, `.python-version`,
 * `.java-version`), and otherwise the toolchain's current stable line. Paths
 * are from the repository root, where the setup actions read them.
 */
export function toolchainStep(decl: ReleaseToolchainDecl, files: ReadonlySet<string>, root: string | null): ToolchainStep {
  const name = typeof decl === "string" ? decl : decl.name;
  const version = typeof decl === "string" ? undefined : decl.version;
  const at = (f: string): string => (root ? `${root}/${f}` : f);
  switch (name) {
    case "node":
      return { name, uses: usesRef(ACTION_PINS.setupNode4), with: [["node-version", version ?? NODE_DEFAULT_VERSION], ["registry-url", "https://registry.npmjs.org"]] };
    case "go":
      return {
        name,
        uses: usesRef(ACTION_PINS.setupGo7),
        with: [version ? ["go-version", version] : files.has("go.mod") ? ["go-version-file", at("go.mod")] : ["go-version", "stable"], ["cache", false]],
      };
    case "python":
      return { name, uses: usesRef(ACTION_PINS.setupPython7), with: [version ? ["python-version", version] : files.has(".python-version") ? ["python-version-file", at(".python-version")] : ["python-version", "3.x"]] };
    case "rust":
      // The action reads rust-toolchain.toml when there is one, and installs stable when not.
      return { name, uses: usesRef(ACTION_PINS.setupRustToolchain2), with: [...(version ? [["toolchain", version] as [string, string]] : []), ["cache", false], ["rustflags", ""]] };
    case "java": {
      const file = [".java-version", ".sdkmanrc", ".tool-versions"].find((f) => files.has(f));
      return { name, uses: usesRef(ACTION_PINS.setupJava6), with: [["distribution", "temurin"], version ? ["java-version", version] : file ? ["java-version-file", at(file)] : ["java-version", "21"]] };
    }
  }
}

/**
 * The toolchains a job sets up: those declared, or those the project's files
 * name. `false` is none, the runner bringing its own. `withNode` adds Node
 * first for a job that runs chant, at the declared version when there is one.
 */
export function resolveToolchains(decl: readonly ReleaseToolchainDecl[] | false | undefined, files: ReadonlySet<string>, root: string | null, withNode: boolean): ToolchainStep[] {
  if (decl === false) return [];
  const list: ReleaseToolchainDecl[] = decl ? [...decl] : detectToolchains(files);
  const named = (d: ReleaseToolchainDecl): ReleaseToolchainName => (typeof d === "string" ? d : d.name);
  const seen = new Set<string>();
  for (const d of list) {
    const n = named(d);
    if (!(RELEASE_TOOLCHAINS as readonly string[]).includes(n)) throw new Error(`release.workflow.toolchains: ${JSON.stringify(n)} is not one of ${RELEASE_TOOLCHAINS.join(", ")}`);
    if (seen.has(n)) throw new Error(`release.workflow.toolchains: ${n} is named twice`);
    seen.add(n);
  }
  if (withNode && !seen.has("node")) list.unshift("node");
  // Node first, so the chant the job runs is there before anything else.
  list.sort((a, b) => (named(a) === "node" ? -1 : named(b) === "node" ? 1 : 0));
  return list.map((d) => toolchainStep(d, files, root));
}

/**
 * The toolchains a job that builds sets up (#5152): `release.workflow.toolchains`,
 * or those the project's root files name, with Node first. A caller that
 * knows no project files sets up Node alone.
 */
export function buildJobToolchains(decl: readonly ReleaseToolchainDecl[] | false | undefined, projectFiles: readonly string[] | undefined, root: string | null): ToolchainStep[] {
  return resolveToolchains(decl, new Set(projectFiles ?? (decl === undefined ? ["package.json"] : [])), root, true);
}

/** A step's lines in a GitHub or Forgejo job. Node renders as it always has: its inputs unquoted. */
export function toolchainLines(steps: readonly ToolchainStep[]): string[] {
  return steps.flatMap((s) => [
    `      - uses: ${s.uses}`,
    ...(s.with.length > 0 ? ["        with:", ...s.with.map(([k, v]) => `          ${k}: ${s.name === "node" ? String(v) : JSON.stringify(v)}`)] : []),
  ]);
}

/**
 * `release.workflow.builds` (#5152): a job per platform that builds on its
 * own runner before the cut and hands its outputs to the cut.
 */
export interface ReleaseBuildConfig {
  /** The job's name, `build-<name>`: lowercase letters, digits and dashes. */
  name: string;
  /** The runner: GitHub's and Forgejo's `runs-on` label (or labels), GitLab's runner `tags`. */
  runner: string | string[];
  /** The command that builds, run with bash from the project root with `CHANT_RELEASE_LABEL` set. */
  build: string;
  /** The files it hands to the cut, from the project root. Shell globs such as `dist/*` are allowed. */
  outputs: string[];
  /** What installs before the build. Default the workflow's install; `false` for none. */
  install?: string | false;
  /** The toolchains this job sets up, in place of the workflow's. */
  toolchains?: ReleaseToolchainDecl[] | false;
  /** Variables for this job only. The cut and publish jobs' `env` is not given to it. */
  env?: Record<string, string>;
}

/** The workflow artifact a build job hands its outputs on in, and the tar archive inside it. */
export const releaseBuildArtifact = (name: string): string => `chant-release-build-${name}`;
export const releaseBuildArchive = (name: string): string => `${releaseBuildArtifact(name)}.tar`;

const OUTPUT = /^[A-Za-z0-9_@+.*?\[\]-][A-Za-z0-9_@+.*?\[\]/-]*$/;

/** Each build checked: a unique job name, a runner, a build, and outputs that stay inside the project. */
export function checkBuilds(builds: readonly ReleaseBuildConfig[]): void {
  const where = "release.workflow.builds";
  const names = new Set<string>();
  for (const b of builds) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(b.name)) throw new Error(`${where}: ${JSON.stringify(b.name)} is not a job name of lowercase letters, digits and dashes`);
    if (names.has(b.name)) throw new Error(`${where}: ${b.name} is named twice`);
    names.add(b.name);
    const runners = Array.isArray(b.runner) ? b.runner : [b.runner];
    if (runners.length === 0 || runners.some((r) => typeof r !== "string" || r.trim() === "" || /[\r\n]/.test(r))) throw new Error(`${where}.${b.name}: runner is blank`);
    if (typeof b.build !== "string" || b.build.trim() === "") throw new Error(`${where}.${b.name}: build is blank`);
    if (!Array.isArray(b.outputs) || b.outputs.length === 0) throw new Error(`${where}.${b.name}: outputs names no file`);
    for (const o of b.outputs) {
      if (!OUTPUT.test(o) || o.split("/").includes("..") || o.startsWith("-")) {
        throw new Error(`${where}.${b.name}: output ${JSON.stringify(o)} is not a path inside the project (letters, digits, ._@+-/ and the globs * ? [ ], with no .. and no leading / or -)`);
      }
    }
  }
}
