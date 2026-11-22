/**
 * #5446: the scan before the stage. What each target would put out is
 * scanned before anything stages: an image through an SBOM of its layers,
 * and every SBOM the publish attaches or a package carries. A finding the
 * policy blocks stops the publish with `publish-scan-failed`, and the
 * registry fake shows nothing was sent. The scanner is a fake matched
 * against a fixture advisory database; no scanner runs, no network is used.
 */
import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { DEFAULT_RELEASE_SCANNER, resolveScan, scanBeforeStage, scannerArgs, scannerEnv, scanToolPath, syftArgs, type ScanContext } from "./publish-scan";
import { createPublishTargets } from "./publish-targets";
import { PublishRunError, runPublish, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeRegistry, writeLockfile, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner } from "./__fixtures__/scan-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-scan-"));
  dirs.push(d);
  return d;
};

function context(cwd: string, scan: ScanContext | null, over: Partial<PublishContext> = {}): PublishContext {
  const env = over.env ?? {};
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [] as ReleaseArtifact[], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: true, ci: "github", reason: "" }, cwd, tag: null, env, redactor: createRedactor(env), log: () => undefined, scan, ...over };
}

const LOCK_CLEAN = (dir: string) =>
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "acme", lockfileVersion: 3, packages: { "": { name: "acme" }, "node_modules/left-pad": { version: "1.3.1" } } }, null, 2));

describe("when a publish scans", () => {
  test("off by default, on with release.scan or under supply-chain, and false turns the group's off with a warning", () => {
    const none = new Set<never>();
    const sc = new Set(["supply-chain" as const]);
    expect(resolveScan(undefined, none)).toEqual({ on: false, from: "off", warning: null });
    expect(resolveScan(true, none)).toMatchObject({ on: true, from: "config" });
    expect(resolveScan({ db: "scan-db" }, none)).toMatchObject({ on: true, from: "config", db: "scan-db" });
    expect(resolveScan(undefined, sc)).toMatchObject({ on: true, from: "supply-chain" });
    expect(resolveScan(false, sc).on).toBe(false);
    expect(resolveScan(false, sc).warning).toContain("supply-chain");
    expect(resolveScan(false, none).warning).toBeNull();
  });

  test("the tools come from CHANT_GRYPE, CHANT_TRIVY and CHANT_SYFT, else PATH, and an offline database is read without an update", () => {
    expect(DEFAULT_RELEASE_SCANNER).toBe("grype");
    expect(scanToolPath("grype", {})).toBe("grype");
    expect(scanToolPath("syft", { CHANT_SYFT: "/tmp/syft/syft" })).toBe("/tmp/syft/syft");
    expect(scannerArgs("grype", "/x/sbom.spdx.json", null)).toEqual(["sbom:/x/sbom.spdx.json", "-o", "json"]);
    expect(scannerEnv("grype", { A: "1" }, "/db")).toEqual({ A: "1", GRYPE_DB_CACHE_DIR: "/db", GRYPE_DB_AUTO_UPDATE: "false", GRYPE_DB_VALIDATE_AGE: "false" });
    expect(scannerEnv("grype", { A: "1" }, null)).toEqual({ A: "1" });
    expect(scannerArgs("trivy", "/x/s.json", "/db")).toEqual(["sbom", "--quiet", "--format", "json", "--cache-dir", "/db", "--skip-db-update", "/x/s.json"]);
    const dir = temp();
    expect(syftArgs(dir, "/o.json")[1]).toBe(`oci-dir:${dir}`);
    expect(syftArgs(join(dir, "image.tar"), "/o.json")[1]).toBe(`oci-archive:${join(dir, "image.tar")}`);
  });
});

describe("the scan before the stage", () => {
  test("an image with a known critical CVE in an OS package stops the publish, and nothing reaches the registry", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-scan-1", token: "tok-scan-1" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const scanner = fakeReleaseScanner();
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-scan-1" } });
      const err = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets, ctx, record: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishRunError);
      expect(err).toMatchObject({ code: "publish-scan-failed", step: "scan", staged: [], revealed: [] });
      expect((err as Error).message).toContain(`${reg.host}/acme/api@${digest}: CVE-2026-50002 (critical) in debian/openssl 3.0.11-1, fixed in 3.0.15-1`);
      // The low zlib finding does not block, and the attached lockfile SBOM was scanned too.
      expect((err as Error).message).not.toContain("CVE-2026-50003");
      expect(scanner.calls[0]).toMatch(/^image .*\/image$/);
      expect(scanner.calls.slice(1)).toEqual(["scan syft", "scan attached"]);
      expect(reg.requests).toEqual([]);
      expect(reg.manifests.size).toBe(0);
      expect(reg.blobs.size).toBe(0);
    } finally {
      await reg.close();
    }
  });

  test("the same image with a patched openssl stages", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-scan-2", token: "tok-scan-2" });
    try {
      const dir = temp();
      writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const scanner = fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] });
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-scan-2" } });
      const run = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets, ctx, record: false });
      expect(run.scan?.subjects.map((s) => [s.findings.map((f) => f.cveId), s.blocking.length])).toEqual([
        [["CVE-2026-50003"], 0],
        [[], 0],
      ]);
      expect(reg.manifests.size).toBeGreaterThan(0);
    } finally {
      await reg.close();
    }
  });

  test("an npm package with a critical CVE in its lockfile stops the publish before npm runs", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false);
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], { npm: join(dir, "no-npm-here") });
    const scanner = fakeReleaseScanner();
    const ctx = context(dir, { scanner, policy: {}, vex: [] });
    const err = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets, ctx, record: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "publish-scan-failed", step: "scan" });
    expect((err as Error).message).toContain("the lockfile of @acme/core@1.4.0: CVE-2026-50001 (critical) in left-pad 1.3.0, fixed in 1.3.1");
    expect(scanner.calls).toEqual(["scan lockfile"]);
  });

  test("a package that carries its own SBOM is scanned through it", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", true);
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const scanner = fakeReleaseScanner();
    const report = await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner, policy: {}, vex: [] } });
    expect(report.subjects.map((s) => s.name)).toEqual(["sbom.spdx.json of @acme/core@1.4.0"]);
    expect(scanner.calls).toEqual(["scan carried"]);
  });

  test("a VEX statement and the policy decide what blocks, as the vuln-gate step does", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false);
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const vex = JSON.stringify({ "@context": "https://openvex.dev/ns/v0.2.0", statements: [{ vulnerability: { name: "CVE-2026-50001" }, status: "not_affected", justification: "vulnerable_code_not_in_execute_path" }] });
    const ctx = context(dir, null);
    const cleared = await scanBeforeStage({ targets, ctx, scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [vex] } });
    expect(cleared.subjects[0]!.suppressed.map((s) => s.finding.cveId)).toEqual(["CVE-2026-50001"]);
    await expect(scanBeforeStage({ targets, ctx, scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [] } })).rejects.toMatchObject({ code: "publish-scan-failed" });
  });

  test("vulnPolicy's failSeverity lowers the bar: a low finding in the image blocks under failSeverity low", async () => {
    const dir = temp();
    writeOciLayout(join(dir, "image"));
    LOCK_CLEAN(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: "127.0.0.1:1/acme/api" })], {});
    const scan = { scanner: fakeReleaseScanner({ image: ["pkg:deb/debian/zlib@1.2.13"] }), vex: [] };
    expect((await scanBeforeStage({ targets, ctx: context(dir, null), scan: { ...scan, policy: {} } })).subjects[0]!.blocking).toEqual([]);
    await expect(scanBeforeStage({ targets, ctx: context(dir, null), scan: { ...scan, policy: { failSeverity: "low" } } })).rejects.toMatchObject({ code: "publish-scan-failed", message: expect.stringContaining("CVE-2026-50003 (low) in debian/zlib") });
  });

  test("with no target that has anything to scan, the report is empty", async () => {
    const report = await scanBeforeStage({ targets: [], ctx: context(temp(), null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [] } });
    expect(report.subjects).toEqual([]);
  });
});
