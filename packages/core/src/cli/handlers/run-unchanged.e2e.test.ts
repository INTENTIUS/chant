/**
 * A run under a release skips a component whose declared inputs did not
 * change since the release the environment runs it from, and records the
 * skip (#4695). A temp repo with no remote, real cuts and a real ledger.
 */
import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cutRelease } from "../../lifecycle/release-cut";
import { appendReleaseRecord, latestPerComponent, readReleaseLedger } from "../../lifecycle/release-ledger";
import type { CompiledTarget, TargetCompiler } from "../../components/release-compile";
import type { DriverComponent } from "../../components/driver";
import type { ComponentInputs } from "../../components/component";
import { recordSkips, releaseRunPrepare, type Skipped } from "./run";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, file: string, content: string): string {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `change ${file}`);
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", `ci/green/${sha}`, sha);
  return sha;
}

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return {
      env,
      params: [],
      components: ["control"],
      buildSteps: {},
      buildInputs: {},
      componentFiles: { control: "control.component.ts" },
      templates: [{ component: "control", path: "dist/fly.json", content: `{"app":"illogical-control"}\n` }],
    };
  },
  async buildArtifacts() {
    return [];
  },
};

const image = (c: string) => `registry.fly.io/illogical-control@sha256:${c.repeat(64)}`;
const cut = (dir: string, label: string, digest: string) => cutRelease({ cwd: dir, compiler, label, actor: "ci", env: {}, images: { control: image(digest) } });

const control: DriverComponent = {
  name: "control",
  dependsOn: [],
  deploy: [
    { phase: "Image", steps: [{ kind: "release-image" }] },
    { phase: "Release", steps: [{ kind: "fly-release", plan: "dist/fly.json", image: "@Image.uri", digest: "@Image.digest" }] },
  ],
};
const declared = { inputs: { control: { paths: ["crates/control"] } } };

describe("run --components --release with declared inputs (#4695)", () => {
  test("skips and records a component whose inputs are unchanged; deploys one whose inputs changed, or with --deploy-unchanged", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@chant.dev");
      git(dir, "config", "user.name", "Test");
      writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["prod"] };\n`);
      commit(dir, "crates/control/main.rs", "fn main() {}\n");
      const r1 = await cut(dir, "v1", "a");
      await appendReleaseRecord(
        { component: "control", env: "prod", digest: `sha256:${"a".repeat(64)}`, gitSha: r1.release.commit, runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z", actor: "ci", releaseDigest: r1.release.releaseDigest },
        { cwd: dir },
      );

      // A commit outside the hub's inputs: the next release leaves it alone.
      commit(dir, "web/index.html", "<p>hi</p>\n");
      const r2 = await cut(dir, "v2", "b");
      const skipped: Skipped = new Map();
      const prepare = releaseRunPrepare({ releaseDigest: r2.release.releaseDigest, label: "v2", release: r2.release }, dir, "prod", { deployUnchanged: false, skipped });
      const prepared = await prepare([control], declared);
      expect(prepared).toEqual({ components: [{ ...control, deploy: [] }] });
      expect([...skipped.keys()]).toEqual(["control"]);

      const written = await recordSkips(skipped, r2.release.releaseDigest, { runId: "run-2" }, dir);
      expect(written).toHaveLength(1);
      const latest = latestPerComponent((await readReleaseLedger("prod", { cwd: dir })).records).get("control")!;
      expect(latest).toMatchObject({
        digest: `sha256:${"a".repeat(64)}`,
        gitSha: r1.release.commit,
        runId: "run-2",
        releaseDigest: r2.release.releaseDigest,
        unchangedSince: { env: "prod", runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z" },
      });

      // --deploy-unchanged deploys it with the image v2 recorded.
      const forced: Skipped = new Map();
      const deployed = await releaseRunPrepare({ releaseDigest: r2.release.releaseDigest, label: "v2", release: r2.release }, dir, "prod", { deployUnchanged: true, skipped: forced })([control], declared);
      expect(forced.size).toBe(0);
      expect(deployed).toMatchObject({ components: [{ deploy: [{ phase: "Image", steps: [{ kind: "release-image", uri: image("b") }] }, control.deploy[1]] }] });

      // A change to an input deploys it, compared against v2, which the skip record names.
      commit(dir, "crates/control/main.rs", "fn main() { println!(); }\n");
      const r3 = await cut(dir, "v3", "c");
      const again: Skipped = new Map();
      const changed = await releaseRunPrepare({ releaseDigest: r3.release.releaseDigest, label: "v3", release: r3.release }, dir, "prod", { deployUnchanged: false, skipped: again })([control], declared);
      expect(again.size).toBe(0);
      expect(changed).toMatchObject({ components: [{ deploy: [{ phase: "Image", steps: [{ kind: "release-image", uri: image("c") }] }, control.deploy[1]] }] });
    });
  });

  test("a version bump that is the same after inputs.normalize is skipped, and the skip record names the normalization (#4718)", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@chant.dev");
      git(dir, "config", "user.name", "Test");
      writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["prod"] };\n`);
      // A stand-in for Arugula's `scripts/release blank`: the file on stdin, its own crates' versions blanked.
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "blank"), `#!/bin/sh\ncase "$1" in *Cargo.toml|*Cargo.lock) exec sed -e 's/^version = ".*"/version = "@V@"/' ;; *) echo "blank: no kind for $1" >&2; exit 2 ;; esac\n`, { mode: 0o755 });
      commit(dir, "crates/control/main.rs", "fn main() {}\n");
      commit(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.0"\n`);
      const r1 = await cut(dir, "v1", "a");
      await appendReleaseRecord(
        { component: "control", env: "prod", digest: `sha256:${"a".repeat(64)}`, gitSha: r1.release.commit, runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z", actor: "ci", releaseDigest: r1.release.releaseDigest },
        { cwd: dir },
      );
      const command = "scripts/blank {path}";
      const normalizing = { inputs: { control: { paths: ["crates/control"], normalize: [{ paths: ["crates/control/Cargo.toml"], command }] } } };
      const prepareFor = async (label: string, digest: string, decl: { inputs: Record<string, ComponentInputs> } = normalizing) => {
        const r = await cut(dir, label, digest);
        const skipped: Skipped = new Map();
        const prepared = await releaseRunPrepare({ releaseDigest: r.release.releaseDigest, label, release: r.release }, dir, "prod", { deployUnchanged: false, skipped })([control], decl);
        return { r, skipped, prepared };
      };

      // Another crate's release bumps the version: the same after the normalizer, so skipped.
      commit(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.1"\n`);
      const bump = await prepareFor("v2", "b");
      expect(bump.prepared).toEqual({ components: [{ ...control, deploy: [] }] });
      expect(bump.skipped.get("control")?.normalized).toEqual([{ path: "crates/control/Cargo.toml", command }]);
      await recordSkips(bump.skipped, bump.r.release.releaseDigest, { runId: "run-2" }, dir);
      const latest = latestPerComponent((await readReleaseLedger("prod", { cwd: dir })).records).get("control")!;
      expect(latest).toMatchObject({ runId: "run-2", unchangedSince: { runId: "run-1" }, normalizedInputs: [{ path: "crates/control/Cargo.toml", command }] });

      // The same bump without normalize deploys, as before.
      commit(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.2"\n`);
      const plain = await prepareFor("v3", "c", declared);
      expect(plain.skipped.size).toBe(0);

      // A dependency added to the manifest differs after the normalizer: deploys.
      commit(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.2"\n\n[dependencies]\nserde = "1"\n`);
      const dep = await prepareFor("v4", "d");
      expect(dep.skipped.size).toBe(0);
      expect(dep.prepared).toMatchObject({ components: [{ deploy: [{ phase: "Image", steps: [{ kind: "release-image", uri: image("d") }] }, control.deploy[1]] }] });

      // A normalizer that fails deploys the component, even for a bump a working one would skip.
      await appendReleaseRecord(
        { component: "control", env: "prod", digest: `sha256:${"d".repeat(64)}`, gitSha: dep.r.release.commit, runId: "run-4", timestamp: new Date().toISOString(), actor: "ci", releaseDigest: dep.r.release.releaseDigest },
        { cwd: dir },
      );
      const failing = { inputs: { control: { paths: ["crates/control"], normalize: [{ paths: ["crates/control/Cargo.toml"], command: "exit 3" }] } } };
      commit(dir, "crates/control/Cargo.toml", `[package]\nname = "control"\nversion = "1.0.3"\n\n[dependencies]\nserde = "1"\n`);
      const failed = await prepareFor("v5", "e", failing);
      expect(failed.skipped.size).toBe(0);
      const skippedAgain = await releaseRunPrepare({ releaseDigest: failed.r.release.releaseDigest, label: "v5", release: failed.r.release }, dir, "prod", { deployUnchanged: false, skipped: new Map() })([control], normalizing);
      expect(skippedAgain).toEqual({ components: [{ ...control, deploy: [] }] });
    });
  });
});
