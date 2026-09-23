/**
 * chant #2514 — the warning a release ahead of real SHA-256 digests: a
 * project whose release ledger or build manifests hold values from the old
 * 32-bit `contentDigest` is told once that they will change.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLegacyContentDigest, resetLegacyDigestWarnings, warnOnLegacyDigests } from "./legacy-digest";
import { appendReleaseRecord, readReleaseLedger, type ReleaseRecordInput } from "./release-ledger";
import { persistBuildManifest, readAllBuildManifests } from "./build-ledger-store";
import { addArchiveEntry, contentDigest, createBuildArchiveManifest } from "../components/verbs/build-archive";

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function release(digest: string, runId: string): ReleaseRecordInput {
  return {
    component: "web",
    env: "prod",
    digest,
    gitSha: "deadbeef",
    runId,
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "ci-bot",
  };
}

const realSha256 = `sha256:${createHash("sha256").update("x").digest("hex")}`;

describe("legacy content digests (#2514)", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore(): void };

  beforeEach(() => {
    resetLegacyDigestWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    resetLegacyDigestWarnings();
  });

  const legacyWarnings = () => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("issues/2514"));

  test("today's contentDigest output is recognised as the old form", () => {
    expect(isLegacyContentDigest(contentDigest("hello"))).toBe(true);
    expect(isLegacyContentDigest(contentDigest(""))).toBe(true);
  });

  test("a real SHA-256 value, a short value and a non-string are not", () => {
    expect(isLegacyContentDigest(realSha256)).toBe(false);
    expect(isLegacyContentDigest("sha256:abc123")).toBe(false);
    expect(isLegacyContentDigest(undefined)).toBe(false);
  });

  test("warns once per project, and not at all without an old value", () => {
    expect(warnOnLegacyDigests([realSha256], "release ledger", "/p/a")).toBe(false);
    expect(warnOnLegacyDigests([contentDigest("x")], "release ledger", "/p/a")).toBe(true);
    expect(warnOnLegacyDigests([contentDigest("y")], "build manifests", "/p/a")).toBe(false);
    expect(warnOnLegacyDigests([contentDigest("y")], "build manifests", "/p/b")).toBe(true);
    expect(legacyWarnings()).toHaveLength(2);
    expect(String(legacyWarnings()[0][0])).toContain("next chant release computes real SHA-256");
  });

  test("reading a release ledger that holds an old value warns once", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      await appendReleaseRecord(release(contentDigest("rendered"), "run-1"), { cwd: dir });
      await appendReleaseRecord(release(contentDigest("rendered-2"), "run-2"), { cwd: dir });

      await readReleaseLedger("prod", { cwd: dir });
      await readReleaseLedger("prod", { cwd: dir });
      expect(legacyWarnings()).toHaveLength(1);
      expect(String(legacyWarnings()[0][0])).toContain("release ledger holds");
    });
  });

  test("a release ledger of real SHA-256 values stays quiet", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      await appendReleaseRecord(release(realSha256, "run-1"), { cwd: dir });
      await readReleaseLedger("prod", { cwd: dir });
      expect(legacyWarnings()).toHaveLength(0);
    });
  });

  test("reading persisted build manifests that hold old values warns once", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      let manifest = createBuildArchiveManifest("web", { now: () => new Date(0) });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "web.json", digest: contentDigest("{}") });
      await persistBuildManifest(manifest, { cwd: dir });

      await readAllBuildManifests({ cwd: dir });
      await readAllBuildManifests({ cwd: dir });
      expect(legacyWarnings()).toHaveLength(1);
      expect(String(legacyWarnings()[0][0])).toContain("build manifests hold");
    });
  });
});
