/**
 * #4840: `release.version` stamps the release's label into package.json at
 * the cut and the publish, so a product needs no version-bump commit.
 */

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease, ReleaseCutError } from "./release-cut";
import { checkCheckoutIsRelease } from "./release-publish";
import { checkVersionLabel, releaseVersionFiles, ReleaseVersionError, stampedChanges, stampReleaseVersion, stampText, type ReleaseVersionConfig } from "./release-version";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { ChantConfigSchema } from "../config";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const PKG = `{\n  "name": "@acme/cli",\n  "version": "0.4.52",\n  "dependencies": {\n    "@intentius/chant": "0.124.77"\n  }\n}\n`;
const ROOT = `{\n  "name": "acme",\n  "private": true,\n  "workspaces": ["packages/*"]\n}\n`;
const LOCK = `{\n  "name": "acme",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "acme",\n      "workspaces": [\n        "packages/*"\n      ]\n    },\n    "packages/cli": {\n      "name": "@acme/cli",\n      "version": "0.4.52"\n    },\n    "node_modules/@acme/cli": {\n      "resolved": "packages/cli",\n      "link": true\n    }\n  }\n}\n`;

/** A workspace with one package, as terragucci's is, committed and green. */
function workspace(label: string): { r: TestRepo; head: string } {
  const r = new TestRepo(label);
  repos.push(r);
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("package.json", ROOT);
  r.write("package-lock.json", LOCK);
  r.write("packages/cli/package.json", PKG);
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return { r, head };
}

const CONFIG: ReleaseVersionConfig = { packages: ["packages/cli"] };

describe("stamping the label (#4840)", () => {
  test("a package.json changes in its version alone, and a lockfile in the package's entry", () => {
    expect(stampText(PKG, "0.4.53", "package")).toBe(PKG.replace(`"version": "0.4.52"`, `"version": "0.4.53"`));
    expect(stampText(LOCK, "0.4.53", "lockfile", ["packages/cli"])).toBe(LOCK.replace(`"version": "0.4.52"`, `"version": "0.4.53"`));
    // The member's own package: the root entry and the lockfile's top-level version.
    const rootLock = `{\n  "name": "yodel",\n  "version": "0.12.1",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "yodel",\n      "version": "0.12.1"\n    }\n  }\n}\n`;
    expect(stampText(rootLock, "0.13.0", "lockfile", ["."])).toBe(rootLock.replaceAll("0.12.1", "0.13.0"));
    // A tab-indented file keeps its tabs.
    expect(stampText(`{\n\t"name": "a",\n\t"version": "1.0.0"\n}\n`, "1.0.1", "package")).toBe(`{\n\t"name": "a",\n\t"version": "1.0.1"\n}\n`);
  });

  test("the files are each package's package.json and the lockfile when there is one", () => {
    const { r } = workspace("release-version-files");
    expect(releaseVersionFiles(r.dir, CONFIG)).toEqual(["packages/cli/package.json", "package-lock.json"]);
    expect(releaseVersionFiles(r.dir, { packages: ["."], lockfile: false })).toEqual(["package.json"]);
  });

  test("stamp, then restore, puts every file back byte for byte", () => {
    const { r } = workspace("release-version-restore");
    const s = stampReleaseVersion({ cwd: r.dir, config: CONFIG, label: "0.4.53" });
    expect(JSON.parse(readFileSync(join(r.dir, "packages/cli/package.json"), "utf-8")).version).toBe("0.4.53");
    expect(JSON.parse(readFileSync(join(r.dir, "package-lock.json"), "utf-8")).packages["packages/cli"].version).toBe("0.4.53");
    s.restore();
    expect(readFileSync(join(r.dir, "packages/cli/package.json"), "utf-8")).toBe(PKG);
    expect(readFileSync(join(r.dir, "package-lock.json"), "utf-8")).toBe(LOCK);
    expect(r.git(["status", "--porcelain"])).toBe("");
  });

  test("a label npm can't take as a version, no label, and a missing package are refused before anything is written", () => {
    expect(() => checkVersionLabel(null)).toThrow(ReleaseVersionError);
    expect(() => checkVersionLabel("v1.4.0")).toThrow(/"v1.4.0" is not a version npm takes/);
    expect((() => { try { checkVersionLabel("v1.4.0"); } catch (e) { return (e as ReleaseVersionError).fix; } })()).toBe("Label the release MAJOR.MINOR.PATCH, such as 1.4.0, with no v.");
    expect(() => checkVersionLabel("1.4")).toThrow(/not a version/);
    expect(() => checkVersionLabel("1.4.0-rc.1")).not.toThrow();
    const { r } = workspace("release-version-refuse");
    expect(() => stampReleaseVersion({ cwd: r.dir, config: { packages: ["packages/cli", "packages/nope"] }, label: "0.4.53" })).toThrow(/packages\/nope\/package.json, which does not exist/);
    expect(r.git(["status", "--porcelain"])).toBe("");
    expect(() => stampReleaseVersion({ cwd: r.dir, config: { packages: ["../other"] }, label: "0.4.53" })).toThrow(/not a path inside the member/);
  });

  test("chant.config.ts takes release.version, and refuses a misspelt key", () => {
    expect(ChantConfigSchema.safeParse({ release: { version: { packages: ["packages/cli"], lockfile: false } } }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ release: { version: { package: ["packages/cli"] } } }).success).toBe(false);
    expect(ChantConfigSchema.safeParse({ release: { version: { packages: [] } } }).success).toBe(false);
  });
});

describe("the publish takes a stamped tree as the commit's (#4840)", () => {
  test("only the named files, stamped with this release's label, pass the checkout check", () => {
    const { r, head } = workspace("release-version-publish");
    // Today's check, with no release.version: a stamped tree is dirty.
    stampReleaseVersion({ cwd: r.dir, config: CONFIG, label: "0.4.53" });
    expect(checkCheckoutIsRelease(r.dir, head, "0.4.53")?.code).toBe("release-worktree-dirty");
    expect(checkCheckoutIsRelease(r.dir, head, "0.4.53", { version: CONFIG, label: "0.4.53" })).toBeNull();
    // Another release's label is not this one's.
    expect(checkCheckoutIsRelease(r.dir, head, "0.4.54", { version: CONFIG, label: "0.4.54" })?.code).toBe("release-worktree-dirty");
    // Any other change in a stamped file, or another file changed, is still dirty.
    r.write("README.md", "changed\n");
    expect(checkCheckoutIsRelease(r.dir, head, "0.4.53", { version: CONFIG, label: "0.4.53" })?.code).toBe("release-worktree-dirty");
    r.git(["checkout", "--", "."]);
    r.git(["clean", "-fdq"]);
    r.write("packages/cli/package.json", PKG.replace("0.4.52", "0.4.53").replace("0.124.77", "0.124.78"));
    expect(stampedChanges({ cwd: r.dir, top: r.dir, commit: head, config: CONFIG, label: "0.4.53", status: r.git(["status", "--porcelain"]) }).size).toBe(0);
  });
});

describe("the cut stamps after its clean-tree check and before it builds (#4840)", () => {
  test("the images and the compile read the label from package.json, and the tree is the commit's after", async () => {
    const { r } = workspace("release-version-cut");
    const seen: string[] = [];
    const version = () => JSON.parse(readFileSync(join(r.dir, "packages/cli/package.json"), "utf-8")).version as string;
    const compiler: TargetCompiler = {
      async compile(env): Promise<CompiledTarget> {
        seen.push(`compile ${version()}`);
        return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [{ component: null, path: "dist/out.json", content: "{}\n" }] };
      },
      async buildArtifacts() {
        return [];
      },
    };
    let stamped: ReturnType<typeof stampReleaseVersion> | null = null;
    try {
      await cutRelease({
        cwd: r.dir,
        compiler,
        label: "0.4.53",
        actor: "alice",
        env: {},
        now: () => new Date("2026-11-08T10:00:00.000Z"),
        stamp: () => {
          seen.push(`stamp ${version()}`);
          stamped = stampReleaseVersion({ cwd: r.dir, config: CONFIG, label: "0.4.53" });
        },
        buildImages: () => {
          seen.push(`images ${version()}`);
          return [];
        },
      });
    } finally {
      (stamped as ReturnType<typeof stampReleaseVersion> | null)?.restore();
    }
    expect(seen).toEqual(["stamp 0.4.52", "images 0.4.53", "compile 0.4.53"]);
    expect(r.git(["status", "--porcelain"])).toBe("");
  });

  test("a dirty tree is refused before anything is stamped", async () => {
    const { r } = workspace("release-version-cut-dirty");
    r.write("packages/cli/package.json", PKG.replace("0.4.52", "9.9.9"));
    let called = false;
    const compiler: TargetCompiler = { async compile(env) { return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [] }; }, async buildArtifacts() { return []; } };
    const err = await cutRelease({ cwd: r.dir, compiler, label: "0.4.53", actor: "alice", env: {}, stamp: () => { called = true; } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("release-worktree-dirty");
    expect(called).toBe(false);
  });
});

describe("ranges of workspace dependencies follow the label (#5155)", () => {
  const CLI = `{\n  "name": "@acme/cli",\n  "version": "0.4.52",\n  "dependencies": {\n    "@acme/core": "^0.4.0",\n    "@acme/other": "0.1.0",\n    "left-pad": "^1.0.0"\n  },\n  "peerDependencies": {\n    "@acme/core": "*"\n  },\n  "optionalDependencies": {\n    "@acme/sibling": "^0.4.0"\n  },\n  "devDependencies": {\n    "@acme/core": "^0.4.0"\n  }\n}\n`;
  const CORE = `{\n  "name": "@acme/core",\n  "version": "0.4.52"\n}\n`;
  const LOCKR = `{\n  "name": "acme",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "acme"\n    },\n    "packages/cli": {\n      "name": "@acme/cli",\n      "version": "0.4.52",\n      "dependencies": {\n        "@acme/core": "^0.4.0",\n        "left-pad": "^1.0.0"\n      }\n    },\n    "packages/core": {\n      "name": "@acme/core",\n      "version": "0.4.52"\n    }\n  }\n}\n`;

  function two(label: string): TestRepo {
    const r = new TestRepo(label);
    repos.push(r);
    r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
    r.write("package-lock.json", LOCKR);
    r.write("packages/cli/package.json", CLI);
    r.write("packages/core/package.json", CORE);
    r.commit("init");
    return r;
  }
  const both = (ranges: ReleaseVersionConfig["ranges"]): ReleaseVersionConfig => ({ packages: ["packages/cli", "packages/core"], ...(ranges ? { ranges } : {}) });
  const cli = (r: TestRepo) => JSON.parse(readFileSync(join(r.dir, "packages/cli/package.json"), "utf-8"));

  test("without ranges, or with keep, only the version changes", () => {
    for (const ranges of [undefined, "keep" as const]) {
      const r = two(`ranges-keep-${ranges ?? "unset"}`);
      stampReleaseVersion({ cwd: r.dir, config: both(ranges), label: "0.5.0" });
      expect(readFileSync(join(r.dir, "packages/cli/package.json"), "utf-8")).toBe(CLI.replace("0.4.52", "0.5.0"));
    }
  });

  test("exact and caret rewrite dependencies on the packages the release stamps, and nothing else", () => {
    const exact = two("ranges-exact");
    stampReleaseVersion({ cwd: exact.dir, config: both("exact"), label: "0.5.0" });
    expect(cli(exact)).toMatchObject({
      version: "0.5.0",
      dependencies: { "@acme/core": "0.5.0", "@acme/other": "0.1.0", "left-pad": "^1.0.0" },
      peerDependencies: { "@acme/core": "*" },
      optionalDependencies: { "@acme/sibling": "^0.4.0" },
      devDependencies: { "@acme/core": "^0.4.0" },
    });
    const caret = two("ranges-caret");
    stampReleaseVersion({ cwd: caret.dir, config: both("caret"), label: "0.5.0" });
    expect(cli(caret).dependencies["@acme/core"]).toBe("^0.5.0");
    // The lockfile's entry for the package follows.
    const lock = JSON.parse(readFileSync(join(caret.dir, "package-lock.json"), "utf-8"));
    expect(lock.packages["packages/cli"]).toMatchObject({ version: "0.5.0", dependencies: { "@acme/core": "^0.5.0", "left-pad": "^1.0.0" } });
  });

  test("restore puts the ranges back byte for byte", () => {
    const r = two("ranges-restore");
    stampReleaseVersion({ cwd: r.dir, config: both("exact"), label: "0.5.0" }).restore();
    expect(r.git(["status", "--porcelain"])).toBe("");
  });

  test("train takes the label the train gives another member's package, caret, and refuses a member with no label", () => {
    const r = two("ranges-train");
    const only: ReleaseVersionConfig = { packages: ["packages/cli"], ranges: "train" };
    stampReleaseVersion({ cwd: r.dir, config: only, label: "0.5.0", train: { "@acme/core": "0.4.60", "@acme/other": "2.0.1", "@acme/sibling": "0.4.9" } });
    expect(cli(r)).toMatchObject({
      dependencies: { "@acme/core": "^0.4.60", "@acme/other": "^2.0.1", "left-pad": "^1.0.0" },
      peerDependencies: { "@acme/core": "*" },
      optionalDependencies: { "@acme/sibling": "^0.4.9" },
    });
    const bare = two("ranges-train-unlabelled");
    expect(() => stampReleaseVersion({ cwd: bare.dir, config: only, label: "0.5.0", train: { "@acme/core": null } })).toThrow(/pins with no label/);
    expect(bare.git(["status", "--porcelain"])).toBe("");
    // With no train, as at a cut, the release's own packages are all it knows.
    const cut = two("ranges-train-cut");
    stampReleaseVersion({ cwd: cut.dir, config: both("train"), label: "0.5.0" });
    expect(cli(cut).dependencies).toEqual({ "@acme/core": "^0.5.0", "@acme/other": "0.1.0", "left-pad": "^1.0.0" });
  });

  test("the publish takes a tree stamped from a train as the commit's, and no other", () => {
    const r = two("ranges-publish");
    const head = r.git(["rev-parse", "HEAD"]).trim();
    const config: ReleaseVersionConfig = { packages: ["packages/cli"], ranges: "train" };
    const train = { "@acme/core": "0.4.60" };
    stampReleaseVersion({ cwd: r.dir, config, label: "0.5.0", train });
    const status = r.git(["status", "--porcelain"]);
    expect(stampedChanges({ cwd: r.dir, top: r.dir, commit: head, config, label: "0.5.0", status }).size).toBe(0);
    expect(stampedChanges({ cwd: r.dir, top: r.dir, commit: head, config, label: "0.5.0", status, trains: [train] }).size).toBe(2);
    expect(checkCheckoutIsRelease(r.dir, head, "0.5.0", { version: config, label: "0.5.0", trains: [train] })).toBeNull();
    expect(checkCheckoutIsRelease(r.dir, head, "0.5.0", { version: config, label: "0.5.0", trains: [{ "@acme/core": "0.4.61" }] })?.code).toBe("release-worktree-dirty");
  });

  test("chant.config.ts takes ranges and refuses another value", () => {
    expect(ChantConfigSchema.safeParse({ release: { version: { packages: ["."], ranges: "train" } } }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ release: { version: { packages: ["."], ranges: "tilde" } } }).success).toBe(false);
  });
});
