import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  persistBuildManifest,
  readBuildManifest,
  listBuildManifestDigests,
  readAllBuildManifests,
  findBuildManifestByArtifactDigest,
} from "./build-ledger-store";
import {
  createBuildArchiveManifest,
  addArchiveEntry,
  type BuildArchiveManifest,
} from "../components/verbs/build-archive";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function makeManifest(component: string, imageDigest: string): BuildArchiveManifest {
  let manifest = createBuildArchiveManifest(component, { now: () => new Date("2026-01-01T00:00:00.000Z") });
  manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: imageDigest });
  manifest = addArchiveEntry(manifest, {
    kind: "sbom",
    path: "image.tar.sbom.json",
    digest: "sha256:sbomdoc",
    mediaType: "application/spdx+json",
    subjectDigest: imageDigest,
    packageCount: 12,
    generator: "syft",
  });
  return manifest;
}

describe("lifecycle/build-ledger-store", () => {
  describe("persistBuildManifest / readBuildManifest", () => {
    test("round-trips a manifest by its own manifestDigest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const manifest = makeManifest("search-service", "sha256:image1");

        const { commit } = await persistBuildManifest(manifest, { cwd: dir });
        expect(commit).toMatch(/^[0-9a-f]{40}$/);

        const readBack = await readBuildManifest(manifest.manifestDigest, { cwd: dir });
        expect(readBack).not.toBeNull();
        expect(readBack).toEqual(manifest);
      });
    });

    test("preserves BOM entries and reproducibility/provenance across the round-trip", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        let manifest = createBuildArchiveManifest("svc");
        manifest = addArchiveEntry(manifest, {
          kind: "image",
          path: "image.tar",
          digest: "sha256:image1",
          provenance: { sourceRef: "deadbeef", artifactDigest: "sha256:image1" },
        });
        manifest = addArchiveEntry(manifest, {
          kind: "sbom",
          path: "image.tar.sbom.json",
          digest: "sha256:sbomdoc",
          mediaType: "application/spdx+json",
          subjectDigest: "sha256:image1",
          bomKind: "software",
          packageCount: 42,
          generator: "syft",
        });

        await persistBuildManifest(manifest, { cwd: dir });
        const readBack = await readBuildManifest(manifest.manifestDigest, { cwd: dir });

        expect(readBack?.contents.find((e) => e.kind === "image")?.reproducibility).toEqual({ basis: "best-effort" });
        expect(readBack?.contents.find((e) => e.kind === "image")?.provenance).toEqual({
          sourceRef: "deadbeef",
          artifactDigest: "sha256:image1",
        });
        const sbomEntry = readBack?.contents.find((e) => e.kind === "sbom");
        expect(sbomEntry?.packageCount).toBe(42);
        expect(sbomEntry?.generator).toBe("syft");
        expect(sbomEntry?.bomKind).toBe("software");
      });
    });

    test("readBuildManifest returns null for an unknown digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readBuildManifest("sha256:doesnotexist", { cwd: dir })).toBeNull();
      });
    });

    test("persisting the same manifest twice overwrites rather than duplicating", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const manifest = makeManifest("svc", "sha256:image1");
        await persistBuildManifest(manifest, { cwd: dir });
        await persistBuildManifest(manifest, { cwd: dir });

        const digests = await listBuildManifestDigests({ cwd: dir });
        expect(digests).toHaveLength(1);
      });
    });

    test("release ledger and build manifest store coexist on the same orphan branch", async () => {
      const { appendReleaseRecord, readReleaseLedger } = await import("./release-ledger");
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const manifest = makeManifest("svc", "sha256:image1");
        await persistBuildManifest(manifest, { cwd: dir });
        await appendReleaseRecord(
          {
            component: "svc",
            env: "prod",
            digest: "sha256:image1",
            gitSha: "deadbeef",
            runId: "run-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            actor: "ci-bot",
          },
          { cwd: dir },
        );

        expect(await readBuildManifest(manifest.manifestDigest, { cwd: dir })).not.toBeNull();
        const { records } = await readReleaseLedger("prod", { cwd: dir });
        expect(records).toHaveLength(1);
      });
    });
  });

  describe("listBuildManifestDigests / readAllBuildManifests", () => {
    test("returns empty when no manifest has ever been persisted", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await listBuildManifestDigests({ cwd: dir })).toEqual([]);
        expect(await readAllBuildManifests({ cwd: dir })).toEqual([]);
      });
    });

    test("lists every persisted manifest's own digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const a = makeManifest("svc-a", "sha256:a1");
        const b = makeManifest("svc-b", "sha256:b1");
        await persistBuildManifest(a, { cwd: dir });
        await persistBuildManifest(b, { cwd: dir });

        const digests = await listBuildManifestDigests({ cwd: dir });
        expect(digests.sort()).toEqual([a.manifestDigest, b.manifestDigest].sort());
      });
    });

    test("readAllBuildManifests reads every persisted manifest back", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const a = makeManifest("svc-a", "sha256:a1");
        const b = makeManifest("svc-b", "sha256:b1");
        await persistBuildManifest(a, { cwd: dir });
        await persistBuildManifest(b, { cwd: dir });

        const manifests = await readAllBuildManifests({ cwd: dir });
        expect(manifests.map((m) => m.component).sort()).toEqual(["svc-a", "svc-b"]);
      });
    });
  });

  describe("findBuildManifestByArtifactDigest", () => {
    test("finds the manifest carrying a matching image-entry digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const manifest = makeManifest("search-service", "sha256:image1");
        await persistBuildManifest(manifest, { cwd: dir });

        const found = await findBuildManifestByArtifactDigest("sha256:image1", { cwd: dir });
        expect(found?.manifestDigest).toBe(manifest.manifestDigest);
        expect(found?.component).toBe("search-service");
      });
    });

    test("returns undefined when no persisted manifest carries the digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const manifest = makeManifest("svc", "sha256:image1");
        await persistBuildManifest(manifest, { cwd: dir });

        expect(await findBuildManifestByArtifactDigest("sha256:unknown", { cwd: dir })).toBeUndefined();
      });
    });

    test("distinguishes between multiple persisted manifests by digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const a = makeManifest("svc-a", "sha256:a1");
        const b = makeManifest("svc-b", "sha256:b1");
        await persistBuildManifest(a, { cwd: dir });
        await persistBuildManifest(b, { cwd: dir });

        expect((await findBuildManifestByArtifactDigest("sha256:a1", { cwd: dir }))?.component).toBe("svc-a");
        expect((await findBuildManifestByArtifactDigest("sha256:b1", { cwd: dir }))?.component).toBe("svc-b");
      });
    });
  });
});
