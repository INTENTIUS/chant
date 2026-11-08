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
