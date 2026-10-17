/**
 * The release cut from a green commit (#4026, ws-104), against temp git repos
 * and a compiler that hands back fixtures.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cutRelease, differingBuildSteps, ReleaseCutError } from "./release-cut";
import {
  appendCut,
  computeReleaseDigest,
  makeRelease,
  persistRelease,
  readAllReleases,
  readCuts,
  readRelease,
  readReleaseTemplate,
  ReleaseLabelError,
  resolveRelease,
  verifyReleaseDigest,
  type ReleaseArtifact,
} from "./release-store";
import { readBlobFromPath, writeLedgerFiles } from "./git";
import { contentDigest } from "../content-digest";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { isImplicitRelease } from "../components/release-promote";
import { releasesDocument } from "../workspace/releases";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "staging", "prod"] };\n`);
  mkdirSync(join(dir, "api"), { recursive: true });
  writeFileSync(join(dir, "api", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "api.component.ts"), "export const api = {};\n");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

function commitFile(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `change ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

const green = (dir: string, sha: string) => git(dir, "tag", `ci/green/${sha}`, sha);
const revoke = (dir: string, sha: string) => git(dir, "tag", `ci/revoked/${sha}`, sha);

/** A compiler that compiles each environment to its own template and builds one image. */
function fixtureCompiler(opts: { buildArgs?: (env: string) => string; imageDigest?: string } = {}): TargetCompiler & { built: string[][]; compiled: string[] } {
  const built: string[][] = [];
  const compiled: string[] = [];
  return {
    built,
    compiled,
    async compile(env): Promise<CompiledTarget> {
      compiled.push(env);
      return {
        env,
        params: [
          { name: "tier", value: env === "prod" ? "large" : "small", source: "default" },
          { name: "region", value: "eu", source: "env" },
        ],
        components: ["api"],
        buildSteps: { api: [{ kind: "docker-build", context: "api", into: "api.tar", buildArgs: { ENV: opts.buildArgs?.(env) ?? "same" } }] },
        buildInputs: { api: ["api", "api/Dockerfile"] },
        componentFiles: { api: "api.component.ts" },
        templates: [{ component: "api", path: "dist/api.template.json", content: `{"env":"${env}"}\n` }],
      };
    },
    async buildArtifacts(env, components): Promise<ReleaseArtifact[]> {
      built.push([env, ...components]);
      return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: opts.imageDigest ?? `sha256:${"a".repeat(64)}` }));
    },
  };
}

const cut = (dir: string, compiler: TargetCompiler, label: string | null, actor = "alice") =>
  cutRelease({ cwd: dir, compiler, label, actor, env: {}, now: () => new Date("2026-10-16T10:00:00.000Z") });

describe("the release digest", () => {
  const subject = {
    member: null,
    commit: "c".repeat(40),
    artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest: "sha256:1" }],
    targets: [{ env: "dev", templates: [{ component: "api", path: "t.json", digest: "sha256:2" }], params: [{ name: "tier", value: "small", source: "default" }] }],
  };

  test("is a jcs1 plan digest of kind release, unchanged by list order and by a param's source", () => {
    const digest = computeReleaseDigest(subject);
    expect(digest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    const reordered = { ...subject, targets: [{ ...subject.targets[0], params: [{ name: "tier", value: "small", source: "cli" }] }] };
    expect(computeReleaseDigest(reordered)).toBe(digest);
  });

  test("changes with a param's value, a template's digest, the commit or the member", () => {
    const digest = computeReleaseDigest(subject);
    expect(computeReleaseDigest({ ...subject, targets: [{ ...subject.targets[0], params: [{ name: "tier", value: "large", source: "default" }] }] })).not.toBe(digest);
    expect(computeReleaseDigest({ ...subject, targets: [{ ...subject.targets[0], templates: [{ component: "api", path: "t.json", digest: "sha256:3" }] }] })).not.toBe(digest);
    expect(computeReleaseDigest({ ...subject, commit: "d".repeat(40) })).not.toBe(digest);
    expect(computeReleaseDigest({ ...subject, member: "api" })).not.toBe(digest);
  });

  test("verifyReleaseDigest catches a release whose content no longer matches its digest", () => {
    const release = makeRelease(subject);
    expect(verifyReleaseDigest(release)).toBe(true);
    expect(verifyReleaseDigest({ ...release, commit: "e".repeat(40) })).toBe(false);
  });
});

describe("cutRelease", () => {
  test("cuts a release from a green commit and stores it apart from the deploy records", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      const compiler = fixtureCompiler();
      const result = await cut(dir, compiler, "v1.0.0");

      expect(compiler.compiled).toEqual(["dev", "staging", "prod"]);
      expect(compiler.built).toEqual([["dev", "api"]]);
      expect(result.label).toBe("v1.0.0");
      expect(result.stored).toBe(true);
      const { release } = result;
      expect(release).toMatchObject({ version: 1, member: null, commit: sha });
      expect(release.artifactDigests).toEqual([{ component: "api", kind: "image", path: "api.tar", digest: `sha256:${"a".repeat(64)}` }]);
      expect(release.targets.map((t) => t.env)).toEqual(["dev", "prod", "staging"]);
      const prod = release.targets.find((t) => t.env === "prod")!;
      expect(prod.templates).toEqual([{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"prod"}\n`) }]);
      expect(prod.params).toEqual([
        { name: "region", value: "eu", source: "env" },
        { name: "tier", value: "large", source: "default" },
      ]);

      // Stored under _releases/, never in a releases.jsonl.
      expect(await readRelease(release.releaseDigest, { cwd: dir })).toEqual(release);
      expect(await readReleaseTemplate(prod.templates[0].digest, { cwd: dir })).toBe(`{"env":"prod"}\n`);
      const { cuts } = await readCuts({ cwd: dir });
      expect(cuts).toEqual([
        { version: 1, releaseDigest: release.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: "2026-10-16T10:00:00.000Z", runOrigin: null, signature: null },
      ]);
      expect(git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle").split("\n").filter((p) => p.endsWith("releases.jsonl"))).toEqual([]);
      expect(await resolveRelease("v1.0.0", { cwd: dir })).toEqual({ release, label: "v1.0.0" });
    });
  });

  test("refuses a commit that isn't green, and writes nothing", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const compiler = fixtureCompiler();
      const err = await cut(dir, compiler, "v1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseCutError);
      expect((err as ReleaseCutError).code).toBe("release-commit-not-green");
      expect(compiler.compiled).toEqual([]);
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: dir }).status).not.toBe(0);
    });
  });

  test("refuses a green commit that was revoked", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      revoke(dir, sha);
      const err = await cut(dir, fixtureCompiler(), "v1").catch((e: unknown) => e);
      expect((err as ReleaseCutError).code).toBe("release-commit-revoked");
    });
  });

  test("refuses a working tree with uncommitted changes to tracked files", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      writeFileSync(join(dir, "README.md"), "edited\n");
      const err = await cut(dir, fixtureCompiler(), "v1").catch((e: unknown) => e);
      expect((err as ReleaseCutError).code).toBe("release-worktree-dirty");
    });
  });

  test("two cuts of one commit give the same releaseDigest; the second is a no-op that keeps the label", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      const first = await cut(dir, fixtureCompiler(), "v1.0.0", "alice");
      const second = await cutRelease({ cwd: dir, compiler: fixtureCompiler(), label: null, actor: "bob", env: { GITHUB_RUN_ID: "9" }, now: () => new Date("2026-10-17T00:00:00.000Z") });
      expect(second.release.releaseDigest).toBe(first.release.releaseDigest);
      expect(second.cut).toBeNull();
      expect(second.label).toBe("v1.0.0");
      expect(second.stored).toBe(false);
      expect((await readCuts({ cwd: dir })).cuts).toHaveLength(1);

      // The same digest under another label is refused.
      const err = await cut(dir, fixtureCompiler(), "v2.0.0").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseLabelError);
      expect((err as ReleaseLabelError).code).toBe("release-already-labelled");
    });
  });

  test("a label names one digest: a second release under a taken label is refused", async () => {
    await withTestDir(async (dir) => {
      const first = initRepo(dir);
      green(dir, first);
      await cut(dir, fixtureCompiler(), "v1");
      const second = commitFile(dir, "api/main.go", "package main\n");
      green(dir, second);
      const err = await cut(dir, fixtureCompiler({ imageDigest: `sha256:${"b".repeat(64)}` }), "v1").catch((e: unknown) => e);
      expect((err as ReleaseLabelError).code).toBe("release-label-taken");
    });
  });

  test("refuses a component whose build steps differ between environments, before anything is built", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      const compiler = fixtureCompiler({ buildArgs: (env) => env });
      const err = await cut(dir, compiler, "v1").catch((e: unknown) => e);
      expect((err as ReleaseCutError).code).toBe("release-build-inputs-differ");
      expect((err as Error).message).toMatch(/"api"/);
      expect(compiler.built).toEqual([]);
    });
  });

  test("a config-only commit gets a release of its own that carries the previous artifact digests", async () => {
    await withTestDir(async (dir) => {
      const first = initRepo(dir);
      green(dir, first);
      const r1 = await cut(dir, fixtureCompiler(), "v1");

      const second = commitFile(dir, "flags.json", `{"newCheckout":true}\n`);
      green(dir, second);
      // A rebuild would give another digest; the source did not change, so nothing is rebuilt.
      const compiler = fixtureCompiler({ imageDigest: `sha256:${"f".repeat(64)}` });
      const r2 = await cut(dir, compiler, "v2");
      expect(compiler.built).toEqual([]);
      expect(r2.reused).toEqual([{ component: "api", from: r1.release.releaseDigest }]);
      expect(r2.release.artifactDigests).toEqual(r1.release.artifactDigests);
      expect(r2.release.releaseDigest).not.toBe(r1.release.releaseDigest);

      // A change under the build context is built again.
      const third = commitFile(dir, "api/main.go", "package main\n");
      green(dir, third);
      const rebuilt = fixtureCompiler({ imageDigest: `sha256:${"f".repeat(64)}` });
      const r3 = await cut(dir, rebuilt, "v3");
      expect(rebuilt.built).toEqual([["dev", "api"]]);
      expect(r3.release.artifactDigests[0].digest).toBe(`sha256:${"f".repeat(64)}`);
    });
  });

  test("refuses a member that declares no environments", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      green(dir, sha);
      const err = await cutRelease({ cwd: dir, compiler: fixtureCompiler(), label: null, actor: "a", environments: [], env: {} }).catch((e: unknown) => e);
      expect((err as ReleaseCutError).code).toBe("release-no-environments");
    });
  });
});

/** A project with no components (#4046): each environment compiles to the files its build writes, with no component. */
function implicitCompiler(): TargetCompiler & { built: string[][] } {
  const built: string[][] = [];
  return {
    built,
    async compile(env): Promise<CompiledTarget> {
      return {
        env,
        params: [{ name: "replicas", value: env === "prod" ? 3 : 1, source: "params-file" }],
        components: [],
        buildSteps: {},
        buildInputs: {},
        componentFiles: {},
        templates: [
          { component: null, path: "dist/build.yaml", content: `replicas: ${env === "prod" ? 3 : 1}\n` },
          { component: null, path: "dist/ops/deploy/op.json", content: `{"name":"deploy"}\n` },
        ],
      };
    },
    async buildArtifacts(env, components): Promise<ReleaseArtifact[]> {
      built.push([env, ...components]);
      return [];
    },
  };
}

describe("an implicit release, of a project with no components (#4046)", () => {
  function initPlainRepo(dir: string): string {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@chant.dev");
    git(dir, "config", "user.name", "Test");
    writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod"] };\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    return git(dir, "rev-parse", "HEAD");
  }

  test("is cut with no artifacts and a target per environment holding the build output, and lists like any release", async () => {
    await withTestDir(async (dir) => {
      const sha = initPlainRepo(dir);
      green(dir, sha);
      const compiler = implicitCompiler();
      const result = await cut(dir, compiler, "v1");
      expect(compiler.built).toEqual([]);
      const { release } = result;
      expect(release.artifactDigests).toEqual([]);
      expect(release.targets).toEqual([
        {
          env: "dev",
          templates: [
            { component: null, path: "dist/build.yaml", digest: contentDigest("replicas: 1\n") },
            { component: null, path: "dist/ops/deploy/op.json", digest: contentDigest(`{"name":"deploy"}\n`) },
          ],
          params: [{ name: "replicas", value: 1, source: "params-file" }],
        },
        {
          env: "prod",
          templates: [
            { component: null, path: "dist/build.yaml", digest: contentDigest("replicas: 3\n") },
            { component: null, path: "dist/ops/deploy/op.json", digest: contentDigest(`{"name":"deploy"}\n`) },
          ],
          params: [{ name: "replicas", value: 3, source: "params-file" }],
        },
      ]);
      expect(await readReleaseTemplate(contentDigest("replicas: 3\n"), { cwd: dir })).toBe("replicas: 3\n");
      expect(isImplicitRelease(release)).toBe(true);

      // A second cut of the commit is the same release.
      const again = await cut(dir, implicitCompiler(), null, "bob");
      expect(again.release.releaseDigest).toBe(release.releaseDigest);
      expect(again.cut).toBeNull();

      const doc = await releasesDocument({ cwd: dir });
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.releases).toHaveLength(1);
      expect(doc.releases[0]).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1", artifactDigests: [], environments: [] });
      expect(doc.releases[0].targets[1].templates[0]).toEqual({ component: null, path: "dist/build.yaml", digest: contentDigest("replicas: 3\n") });
    });
  });

  test("is still refused when components are declared but none is enabled and nothing was compiled", async () => {
    await withTestDir(async (dir) => {
      const sha = initPlainRepo(dir);
      green(dir, sha);
      const empty: TargetCompiler = {
        async compile(env) {
          return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [] };
        },
        async buildArtifacts() {
          return [];
        },
      };
      const err = await cut(dir, empty, "v1").catch((e: unknown) => e);
      expect((err as ReleaseCutError).code).toBe("release-no-components");
    });
  });
});

describe("the release store", () => {
  test("a release is written once and never rewritten", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const release = makeRelease({ member: null, commit: "c".repeat(40), artifactDigests: [], targets: [{ env: "dev", templates: [], params: [] }] });
      expect((await persistRelease(release, [], { cwd: dir })).written).toBe(true);
      const tip = git(dir, "rev-parse", "chant/lifecycle");
      expect((await persistRelease(release, [], { cwd: dir })).written).toBe(false);
      expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(tip);
    });
  });

  test("a stored release whose content does not hash to its digest is not read, and counts as malformed", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const release = makeRelease({ member: null, commit: "c".repeat(40), artifactDigests: [], targets: [{ env: "dev", templates: [], params: [] }] });
      await persistRelease(release, [], { cwd: dir });
      const name = `${release.releaseDigest.replace(/:/g, "_")}.json`;
      const stored = (await readBlobFromPath("_releases", name, { cwd: dir }))!;
      await writeLedgerFiles([{ path: `_releases/${name}`, content: stored.replace("c".repeat(40), "d".repeat(40)) }], "tamper", { cwd: dir });
      expect(await readRelease(release.releaseDigest, { cwd: dir })).toBeNull();
      expect(await readAllReleases({ cwd: dir })).toEqual({ releases: [], malformed: 1 });
    });
  });

  test("an unlabelled cut can be labelled once; an invalid label is refused", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const base = { releaseDigest: `jcs1-sha256:${"1".repeat(64)}`, actor: "a", timestamp: "2026-10-16T00:00:00.000Z", runOrigin: null };
      expect(await appendCut({ ...base, label: null }, { cwd: dir })).toMatchObject({ appended: true });
      expect(await appendCut({ ...base, label: null }, { cwd: dir })).toEqual({ appended: false, label: null });
      expect(await appendCut({ ...base, label: "v1" }, { cwd: dir })).toMatchObject({ appended: true });
      expect(await appendCut({ ...base, label: "v1" }, { cwd: dir })).toEqual({ appended: false, label: "v1" });
      await expect(appendCut({ ...base, label: "has space" }, { cwd: dir })).rejects.toMatchObject({ code: "release-label-invalid" });
    });
  });
});

describe("differingBuildSteps", () => {
  test("names the components whose steps differ, and ignores one present in only some environments", () => {
    const t = (env: string, steps: Record<string, unknown[]>): CompiledTarget => ({ env, params: [], components: Object.keys(steps), buildSteps: steps, buildInputs: {}, componentFiles: {}, templates: [] });
    expect(differingBuildSteps([t("dev", { a: [{ x: 1 }], b: [{ y: 1 }] }), t("prod", { a: [{ x: 2 }], b: [{ y: 1 }] }), t("qa", { c: [] })])).toEqual([{ component: "a", envs: ["dev", "prod"] }]);
  });
});
