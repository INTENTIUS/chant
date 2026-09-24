/**
 * chant #2514 — digests recorded before real SHA-256. A project whose release
 * ledger or build manifests hold values from the old 32-bit `contentDigest`
 * is told once; those records read back flagged `legacy-digest`, and nothing
 * is re-keyed or rewritten.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_DIGEST_ACCEPTED_THROUGH,
  LEGACY_DIGEST_FLAG,
  flagLegacyDigest,
  isLegacyContentDigest,
  resetLegacyDigestWarnings,
  warnOnLegacyDigests,
} from "./legacy-digest";
import { appendReleaseRecord, readReleaseLedger, type ReleaseRecord, type ReleaseRecordInput } from "./release-ledger";
import {
  findBuildManifestByArtifactDigest,
  persistBuildManifest,
  readAllBuildManifests,
  readBuildManifest,
} from "./build-ledger-store";
import { readBlobFromPath } from "./git";
import { compareAcrossEnvironments } from "./status";
import { addArchiveEntry, contentDigest, createBuildArchiveManifest } from "../components/verbs/build-archive";

/** The 32-bit hash chant labelled `sha256:` up to 0.80.0, kept here to make old values. */
function legacyContentDigest(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `sha256:${hex.repeat(8).slice(0, 64)}`;
}

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

  test("the old contentDigest output is recognised, and today's is not", () => {
    expect(isLegacyContentDigest(legacyContentDigest("hello"))).toBe(true);
    expect(isLegacyContentDigest(legacyContentDigest(""))).toBe(true);
    expect(isLegacyContentDigest(contentDigest("hello"))).toBe(false);
  });

  test("a real SHA-256 value, a short value and a non-string are not", () => {
    expect(isLegacyContentDigest(realSha256)).toBe(false);
    expect(isLegacyContentDigest("sha256:abc123")).toBe(false);
    expect(isLegacyContentDigest(undefined)).toBe(false);
  });

  test("warns once per project, and not at all without an old value", () => {
    expect(warnOnLegacyDigests([realSha256], "release ledger", "/p/a")).toBe(false);
    expect(warnOnLegacyDigests([legacyContentDigest("x")], "release ledger", "/p/a")).toBe(true);
    expect(warnOnLegacyDigests([legacyContentDigest("y")], "build manifests", "/p/a")).toBe(false);
    expect(warnOnLegacyDigests([legacyContentDigest("y")], "build manifests", "/p/b")).toBe(true);
    expect(legacyWarnings()).toHaveLength(2);
    expect(String(legacyWarnings()[0][0])).toContain("chant now computes real SHA-256");
    expect(String(legacyWarnings()[0][0])).toContain(`accepts them through ${LEGACY_DIGEST_ACCEPTED_THROUGH}`);
  });

  test("flagLegacyDigest adds the flag once, keeps other flags, and leaves real values alone", () => {
    const old = legacyContentDigest("x");
    const record: { id: number; flags?: string[] } = { id: 1 };
    expect(flagLegacyDigest(record, [realSha256])).toEqual({ id: 1 });
    expect(flagLegacyDigest(record, [undefined, old])).toEqual({ id: 1, flags: [LEGACY_DIGEST_FLAG] });
    expect(flagLegacyDigest({ flags: ["legacy-digest"] }, [old])).toEqual({ flags: ["legacy-digest"] });
    expect(flagLegacyDigest({ flags: ["other"] }, [old])).toEqual({ flags: ["other", "legacy-digest"] });
  });

  test("a release ledger with old and new values: old entries read back flagged, warned once, never re-keyed", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const old = legacyContentDigest("rendered");
      await appendReleaseRecord(release(old, "run-1"), { cwd: dir });
      await appendReleaseRecord(release(contentDigest("rendered"), "run-2"), { cwd: dir });

      const { records } = await readReleaseLedger("prod", { cwd: dir });
      await readReleaseLedger("prod", { cwd: dir });
      expect(legacyWarnings()).toHaveLength(1);
      expect(String(legacyWarnings()[0][0])).toContain("release ledger holds");

      expect(records.map((r) => [r.runId, r.digest, r.flags])).toEqual([
        ["run-1", old, [LEGACY_DIGEST_FLAG]],
        ["run-2", contentDigest("rendered"), undefined],
      ]);

      // Appending a record read back with its flag does not persist the flag,
      // and the old digest is written exactly as it was.
      const flagged = { ...records[0]!, runId: "run-3" } as ReleaseRecord;
      const { record: written } = await appendReleaseRecord(flagged, { cwd: dir });
      expect(written.flags).toBeUndefined();
      expect(written.digest).toBe(old);
      const raw = await readBlobFromPath("prod", "releases.jsonl", { cwd: dir });
      expect(raw ?? "").not.toContain("legacy-digest");
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

  test("an old persisted build manifest reads back under its old key, flagged, and is found by its old artifact digest", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const oldEntry = legacyContentDigest("{}");
      const oldManifestDigest = legacyContentDigest(`template:web.json:${oldEntry}`);
      const oldManifest = {
        version: 1 as const,
        component: "web",
        createdAt: new Date(0).toISOString(),
        contents: [{ kind: "template" as const, path: "web.json", digest: oldEntry }],
        manifestDigest: oldManifestDigest,
      };
      await persistBuildManifest(oldManifest, { cwd: dir });

      let fresh = createBuildArchiveManifest("web", { now: () => new Date(0) });
      fresh = addArchiveEntry(fresh, { kind: "template", path: "web.json", digest: contentDigest("{}") });
      await persistBuildManifest(fresh, { cwd: dir });

      const all = await readAllBuildManifests({ cwd: dir });
      await readAllBuildManifests({ cwd: dir });
      expect(legacyWarnings()).toHaveLength(1);
      expect(String(legacyWarnings()[0][0])).toContain("build manifests hold");
      expect(all).toHaveLength(2);

      const old = await readBuildManifest(oldManifestDigest, { cwd: dir });
      expect(old?.manifestDigest).toBe(oldManifestDigest);
      expect(old?.flags).toEqual([LEGACY_DIGEST_FLAG]);
      expect((await findBuildManifestByArtifactDigest(oldEntry, { cwd: dir }))?.manifestDigest).toBe(oldManifestDigest);
      expect((await readBuildManifest(fresh.manifestDigest, { cwd: dir }))?.flags).toBeUndefined();

      // Persisting a flagged manifest again writes no flag.
      await persistBuildManifest(old!, { cwd: dir });
      const raw = await readBlobFromPath("_builds", `${oldManifestDigest.replace(/:/g, "_")}.json`, { cwd: dir });
      expect(raw ?? "").not.toContain("legacy-digest");
    });
  });

  test("a cross-environment comparison of an old and a new digest says it cannot tell", () => {
    const rec = (env: string, digest: string): ReleaseRecord => ({ version: 1, ...release(digest, `${env}-1`), env });
    const mixed = compareAcrossEnvironments(
      "web",
      { name: "staging", records: [rec("staging", contentDigest("x"))] },
      { name: "prod", records: [rec("prod", legacyContentDigest("x"))] },
    );
    expect(mixed.same).toBe(false);
    expect(mixed.mixedDigestForms).toBe(true);

    const differentNew = compareAcrossEnvironments(
      "web",
      { name: "staging", records: [rec("staging", contentDigest("x"))] },
      { name: "prod", records: [rec("prod", contentDigest("y"))] },
    );
    expect(differentNew.mixedDigestForms).toBeUndefined();
  });
});
