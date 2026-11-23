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
import { DEFAULT_RELEASE_SCANNER, findingsAttachment, parseScanDatabase, PublishScanError, resolveScan, SCAN_FINDINGS_FILE, SCAN_FINDINGS_MEDIA_TYPE, SCAN_RECORD_TARGET, scanBeforeStage, scannerArgs, scannerEnv, scanRecord, scanToolPath, syftArgs, type ScanContext } from "./publish-scan";
import { parsePublishRecords, publishProgress } from "./publish-record";
import { createPublishTargets } from "./publish-targets";
import { PublishRunError, runPublish, type PublishContext, type PublishItem } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { GITLAB_REGISTRY_TYPES, startFakeRegistry, writeLockfile, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";
import { bundleReferrerManifest, CHANT_MEDIA_TYPE_ANNOTATION, legacyReferrerManifest, referrerManifest } from "./publish-oci";
import { IN_TOTO_MEDIA_TYPE, type Attachment } from "./publish-attachments";
import { HELM_CHART_MEDIA_TYPE, HELM_CONFIG_MEDIA_TYPE } from "./publish-helm";
import { SBOM_MEDIA_TYPES } from "../components/verbs/sbom-generator";
import { SIGSTORE_BUNDLE_MEDIA_TYPE, SPDX_PREDICATE } from "./publish-signing";
import { bytesDigest } from "./publish-targets";
import { fakeReleaseScanner, layerSpdx } from "./__fixtures__/scan-fakes";

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
    expect(scannerEnv("grype", { A: "1" }, "/db")).toEqual({ A: "1", GRYPE_CHECK_FOR_APP_UPDATE: "false", GRYPE_DB_CACHE_DIR: "/db", GRYPE_DB_AUTO_UPDATE: "false", GRYPE_DB_VALIDATE_AGE: "false" });
    expect(scannerEnv("grype", { A: "1" }, null)).toEqual({ A: "1", GRYPE_CHECK_FOR_APP_UPDATE: "false" });
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
      // The low zlib finding does not block. The image is scanned through the SBOM of its layers, which is the one it would be published with.
      expect((err as Error).message).not.toContain("CVE-2026-50003");
      expect(scanner.calls[0]).toMatch(/^image .*\/image$/);
      expect(scanner.calls.slice(1)).toEqual(["scan syft"]);
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
      expect(run.scan?.subjects.map((s) => [s.findings.map((f) => f.cveId), s.blocking.length])).toEqual([[["CVE-2026-50003"], 0]]);
      expect(reg.manifests.size).toBeGreaterThan(0);
      // syft ran once: the scan and the stage share the SBOM of the layers.
      expect(scanner.calls.filter((c) => c.startsWith("image "))).toHaveLength(1);
    } finally {
      await reg.close();
    }
  });

  test("an npm package with a critical CVE in its lockfile stops the publish before npm runs", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], { npm: join(dir, "no-npm-here") });
    const scanner = fakeReleaseScanner();
    const ctx = context(dir, { scanner, policy: {}, vex: [] });
    const err = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets, ctx, record: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "publish-scan-failed", step: "scan" });
    expect((err as Error).message).toContain("the lockfile of @acme/core@1.4.0: CVE-2026-50001 (critical) in left-pad 1.3.0, fixed in 1.3.1");
    expect(scanner.calls).toEqual(["scan lockfile"]);
  });

  test("a development dependency in the lockfile does not block: the SBOM lists what installing the package brings in", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "is-odd": "^3.0.0" });
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "acme", lockfileVersion: 3, packages: { "": { name: "acme", devDependencies: { "left-pad": "1.3.0" } }, "node_modules/left-pad": { version: "1.3.0", dev: true }, "node_modules/is-odd": { version: "3.0.1" } } }, null, 2),
    );
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const report = await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [] } });
    // The package itself and is-odd; left-pad 1.3.0, critical in the fake database, is not in it.
    expect(report.subjects.map((s) => [s.name, s.packages, s.findings.length])).toEqual([["the lockfile of @acme/core@1.4.0", 2, 0]]);
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
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const vex = JSON.stringify({ "@context": "https://openvex.dev/ns/v0.2.0", statements: [{ vulnerability: { name: "CVE-2026-50001" }, products: [{ "@id": "pkg:npm/%40acme/core@1.4.0", subcomponents: [{ "@id": "pkg:npm/left-pad@1.3.0" }] }], status: "not_affected", justification: "vulnerable_code_not_in_execute_path" }] });
    const ctx = context(dir, null);
    const cleared = await scanBeforeStage({ targets, ctx, scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [vex], vexSources: ["vex/core.openvex.json"] } });
    expect(cleared.subjects[0]!.suppressed.map((s) => s.finding.cveId)).toEqual(["CVE-2026-50001"]);
    expect(scanRecord(cleared).subjects[0]!.findings).toEqual([expect.objectContaining({ id: "CVE-2026-50001", outcome: "suppressed", statement: "vex/core.openvex.json#statements[0]" })]);
    expect(cleared.vex).toBeUndefined();
    await expect(scanBeforeStage({ targets, ctx, scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [] } })).rejects.toMatchObject({ code: "publish-scan-failed" });
  });

  test("a VEX statement clears the advisory only in the image it names: the same advisory in another image blocks", async () => {
    const dir = temp();
    writeOciLayout(join(dir, "image"));
    LOCK_CLEAN(dir);
    const targets = await createPublishTargets(
      [PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: "127.0.0.1:1/acme/api" }), PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: "127.0.0.1:1/acme/worker" })],
      {},
    );
    const only = (repository: string) => JSON.stringify({ statements: [{ vulnerability: { name: "CVE-2026-50002" }, products: [{ "@id": `pkg:oci/${repository.split("/").pop()}?repository_url=${repository}`, subcomponents: [{ "@id": "pkg:deb/debian/openssl@3.0.11-1" }] }], status: "not_affected" }] });
    const lines: string[] = [];
    const err = await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [only("127.0.0.1:1/acme/api")], vexSources: ["api.openvex.json"] }, say: (l) => lines.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishScanError);
    const report = (err as PublishScanError).report;
    expect(report.subjects.map((s) => [s.name.split("@")[0], s.suppressed.length, s.blocking.length])).toEqual([["127.0.0.1:1/acme/api", 1, 0], ["127.0.0.1:1/acme/worker", 0, 1]]);
    expect((err as Error).message).toContain("127.0.0.1:1/acme/worker@");
    expect((err as Error).message).not.toContain("127.0.0.1:1/acme/api@");
    expect(lines.some((l) => l.includes("api.openvex.json#statements[0] cleared CVE-2026-50002 in debian/openssl 3.0.11-1 of 127.0.0.1:1/acme/api@"))).toBe(true);
    // Naming both images clears both.
    const both = JSON.stringify({ statements: [{ vulnerability: { name: "CVE-2026-50002" }, products: [{ "@id": "127.0.0.1:1/acme/api" }, { "@id": "127.0.0.1:1/acme/worker" }], status: "not_affected" }] });
    const ok = await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [both] } });
    expect(ok.subjects.map((s) => s.suppressed.length)).toEqual([1, 1]);
  });

  test("a statement that names no products is refused and one that matches nothing is reported unused, in the report and the record", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const vex = JSON.stringify({
      statements: [
        { vulnerability: { name: "CVE-2026-50001" }, status: "not_affected" },
        { vulnerability: { name: "CVE-2026-50001" }, products: [{ "@id": "pkg:npm/%40acme/cli" }], status: "not_affected" },
        { vulnerability: { name: "CVE-2026-50001" }, products: [{ "@id": "pkg:npm/%40acme/core" }], status: "fixed" },
      ],
    });
    const lines: string[] = [];
    const report = await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [vex], vexSources: ["vex.json"] }, say: (l) => lines.push(l) });
    expect(report.subjects[0]!.suppressed).toEqual([expect.objectContaining({ status: "fixed", statement: "vex.json#statements[2]" })]);
    expect(report.vex).toEqual({
      invalid: [{ statement: "vex.json#statements[0]", vulnerability: "CVE-2026-50001", reason: expect.stringContaining("names no products") }],
      unused: [{ statement: "vex.json#statements[1]", vulnerability: "CVE-2026-50001" }],
    });
    expect(scanRecord(report).vex).toEqual(report.vex);
    expect(lines.some((l) => l.includes("vex.json#statements[0] (CVE-2026-50001) is not applied"))).toBe(true);
    expect(lines.some((l) => l.includes("vex.json#statements[1] (CVE-2026-50001) matched no finding"))).toBe(true);
    // Without the scoped statement, the one without products clears nothing and the finding blocks.
    const unscoped = JSON.stringify({ statements: [{ vulnerability: { name: "CVE-2026-50001" }, status: "not_affected" }] });
    await expect(scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [unscoped] } })).rejects.toMatchObject({ code: "publish-scan-failed" });
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

describe("the image's SBOM is the one made from its layers (#5446)", () => {
  /** The SBOM referrer a stage pushed: its item and the document. */
  const pushedSbom = (reg: Awaited<ReturnType<typeof startFakeRegistry>>, items: PublishItem[]) => {
    const item = items.find((i) => i.attachment === "sbom")!;
    const manifest = JSON.parse(reg.manifests.get(item.digest!)!.bytes.toString("utf-8")) as { layers: Array<{ digest: string }> };
    return { item, doc: JSON.parse(reg.blobs.get(manifest.layers[0]!.digest)!.toString("utf-8")) as { name: string; documentNamespace: string; creationInfo: { created: string }; packages: Array<{ externalRefs: Array<{ referenceLocator: string }> }> } };
  };

  test("a publish that scans attaches the layers' SBOM, which lists the OS packages, dated with the cut and named for the image", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-sbom-1", token: "tok-sbom-1" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const repository = `${reg.host}/acme/api`;
      const decl = PublishDeclarationSchema.parse({ type: "oci", image: "image", repository });
      const scanner = fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] });
      const cut = { actor: "a", label: "v1.4.0", timestamp: "2026-11-20T10:00:00.000Z", runId: null, signature: null };
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-sbom-1" }, cut });

      const [target] = await createPublishTargets([decl], {});
      const plan = await target!.plan(ctx);
      expect(plan.find((i) => i.attachment === "sbom")).toEqual({ name: "sbom.spdx.json", destination: `${repository}, a referrer of the image, made from its layers when staged`, attachment: "sbom" });
      expect(scanner.calls).toEqual([]);

      const staged = await target!.stage(ctx);
      const { doc } = pushedSbom(reg, staged.items);
      expect(doc.packages.flatMap((p) => p.externalRefs.map((r) => r.referenceLocator))).toEqual(["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"]);
      expect(doc.name).toBe(`${repository}@${digest}`);
      expect(doc.documentNamespace).toBe(`https://intentius.io/chant/sbom/sha256/${digest.slice(7)}`);
      expect(doc.creationInfo.created).toBe("2026-11-20T10:00:00Z");

      // Another run makes the same bytes, so the referrer is found and not pushed again.
      const [again] = await createPublishTargets([decl], {});
      const second = await again!.stage(ctx);
      expect(second.items.find((i) => i.attachment === "sbom")).toMatchObject({ digest: pushedSbom(reg, staged.items).item.digest, present: true });
    } finally {
      await reg.close();
    }
  });

  test("a publish that does not scan keeps the lockfile SBOM, and a declared sbom file wins over the layers", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-sbom-2", token: "tok-sbom-2" });
    try {
      const dir = temp();
      writeOciLayout(join(dir, "image"));
      writeLockfile(dir);
      const env = { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-sbom-2" };
      const [plain] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/plain` })], {});
      const lockfile = pushedSbom(reg, (await plain!.stage(context(dir, null, { env }))).items).doc as unknown as { creationInfo: { creators: string[] } };
      expect(lockfile.creationInfo.creators.join(" ")).toContain("chant-lockfile-sbom");

      writeFileSync(join(dir, "image.spdx.json"), layerSpdx("declared", ["pkg:npm/left-pad@1.3.1"]));
      const scanner = fakeReleaseScanner();
      const [declared] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/declared`, sbom: "image.spdx.json" })], {});
      const ctx = context(dir, { scanner, policy: { failSeverity: "critical" }, vex: [] }, { env });
      // The image still goes through the scan, and so does the declared file.
      const subjects = await declared!.scanSubjects!(ctx);
      expect(subjects.map((s) => s.name.split(" of ")[0])).toEqual([expect.stringContaining("@sha256:"), "image.spdx.json"]);
      const doc = pushedSbom(reg, (await declared!.stage(ctx)).items).doc;
      expect(doc.name).toBe("declared");
    } finally {
      await reg.close();
    }
  });
});

describe("what the scan found is kept with the release (#5446)", () => {
  test("the scanner's database version is read from grype's and trivy's JSON", () => {
    expect(parseScanDatabase("grype", JSON.stringify({ schemaVersion: "v6.0.2", built: "2026-11-20T00:12:00Z", path: "/db", valid: true }))).toEqual({ version: "v6.0.2", built: "2026-11-20T00:12:00Z" });
    expect(parseScanDatabase("trivy", JSON.stringify({ Version: "0.60.0", VulnerabilityDB: { Version: 2, UpdatedAt: "2026-11-20T06:00:00Z" } }))).toEqual({ version: "2", built: "2026-11-20T06:00:00Z" });
    expect(parseScanDatabase("grype", "not json")).toBeNull();
    expect(parseScanDatabase("trivy", "{}")).toBeNull();
  });

  test("a scanned line holds every finding with what the policy made of it, and a reader of the record accepts it", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
    writeLockfile(dir);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const scanner = { ...fakeReleaseScanner(), database: async () => ({ version: "v6.0.2", built: "2026-11-20T00:12:00Z" }) };
    const err = (await scanBeforeStage({ targets, ctx: context(dir, null), scan: { scanner, policy: {}, vex: [] } }).catch((e: unknown) => e)) as PublishScanError;
    expect(err).toBeInstanceOf(PublishScanError);
    const record = scanRecord(err.report);
    expect(record).toEqual({
      scanner: "fake-grype v0.0.1",
      database: { version: "v6.0.2", built: "2026-11-20T00:12:00Z" },
      subjects: [{ target: "npm (1 package)", name: "the lockfile of @acme/core@1.4.0", packages: expect.any(Number), findings: [{ id: "CVE-2026-50001", severity: "critical", package: "left-pad", version: "1.3.0", fixedVersion: "1.3.1", outcome: "severity-threshold" }] }],
    });
    const line = JSON.stringify({ version: 1, releaseDigest: "sha256:r", label: "v1.4.0", target: SCAN_RECORD_TARGET.key, kind: "scan", name: "scan", step: "scan-failed", items: [], state: {}, scan: record, runId: "r", timestamp: "2026-11-21T00:00:00.000Z" });
    const parsed = parsePublishRecords(line);
    expect(parsed.malformed).toBe(0);
    expect(parsed.records[0]).toMatchObject({ step: "scan-failed", scan: record });
    // A scan line is no target's progress, so a resume does not take it for a stage.
    expect(publishProgress(parsed.records).staged.size).toBe(0);
  });

  test("the stage pushes an image's findings beside its SBOM, and the reveal lists them", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-find-1", token: "tok-find-1" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const scanner = { ...fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] }), database: async () => ({ version: "v6.0.2" }) };
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-find-1" } });
      const run = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets: [target!], ctx, record: false });
      const findings = run.published[0]!.items.find((i) => i.attachment === "scan")!;
      expect(findings.name).toBe(SCAN_FINDINGS_FILE);
      const manifest = JSON.parse(reg.manifests.get(findings.digest!)!.bytes.toString("utf-8")) as { artifactType: string; subject: { digest: string }; layers: Array<{ digest: string; mediaType: string; annotations: Record<string, string> }>; annotations: Record<string, string> };
      // #5540: pushed as application/json, the findings' own type in an annotation.
      expect(manifest.artifactType).toBe("application/json");
      expect(manifest.layers[0]!.mediaType).toBe("application/json");
      expect(manifest.annotations[CHANT_MEDIA_TYPE_ANNOTATION]).toBe(SCAN_FINDINGS_MEDIA_TYPE);
      expect(manifest.layers[0]!.annotations[CHANT_MEDIA_TYPE_ANNOTATION]).toBe(SCAN_FINDINGS_MEDIA_TYPE);
      expect(manifest.annotations["org.opencontainers.image.title"]).toBe(SCAN_FINDINGS_FILE);
      expect(manifest.subject.digest).toBe(digest);
      const doc = JSON.parse(reg.blobs.get(manifest.layers[0]!.digest)!.toString("utf-8")) as { scanner: string; database: unknown; subject: string; subjects: Array<{ findings: Array<{ id: string; outcome: string }> }> };
      expect(doc).toMatchObject({ scanner: "fake-grype v0.0.1", database: { version: "v6.0.2" }, subject: digest });
      expect(doc.subjects[0]!.findings).toEqual([expect.objectContaining({ id: "CVE-2026-50003", outcome: "reported" })]);
      expect(findingsAttachment(run.scan!, "sha256:other")).toBeNull();
    } finally {
      await reg.close();
    }
  });
});


describe("a registry that checks media types takes every referrer (#5540)", () => {
  const subject = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"a".repeat(64)}`, size: 100 };
  const file = (kind: Attachment["kind"], name: string, mediaType: string): Attachment => {
    const bytes = new Uint8Array(Buffer.from(`{"name":"${name}"}`));
    return { kind, name, mediaType, bytes, digest: bytesDigest(bytes) };
  };
  type Manifest = { artifactType: string; config: { mediaType: string }; layers: Array<{ mediaType: string }>; annotations: Record<string, string> };
  const parse = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf-8")) as Manifest;

  test("every type chant puts in an artifact manifest's artifactType, config or layer is one registry.gitlab.com knows", () => {
    const manifests = [
      referrerManifest(file("sbom", "sbom.spdx.json", SBOM_MEDIA_TYPES.spdx), subject),
      referrerManifest(file("sbom", "sbom.cdx.json", SBOM_MEDIA_TYPES.cyclonedx), subject),
      referrerManifest(file("provenance", "release.intoto.json", IN_TOTO_MEDIA_TYPE), subject),
      referrerManifest(file("scan", SCAN_FINDINGS_FILE, SCAN_FINDINGS_MEDIA_TYPE), subject),
      bundleReferrerManifest(file("provenance", "attestation.sigstore.json", SIGSTORE_BUNDLE_MEDIA_TYPE), SPDX_PREDICATE, subject),
    ].map(parse);
    const types = new Set(manifests.flatMap((m) => [m.artifactType, m.config.mediaType, ...m.layers.map((l) => l.mediaType)]));
    for (const t of [...types, HELM_CONFIG_MEDIA_TYPE, HELM_CHART_MEDIA_TYPE]) expect(GITLAB_REGISTRY_TYPES.has(t), t).toBe(true);
  });

  test("the SBOM and provenance referrers keep their shape, so their digests do not move", () => {
    for (const a of [file("sbom", "sbom.spdx.json", SBOM_MEDIA_TYPES.spdx), file("provenance", "release.intoto.json", IN_TOTO_MEDIA_TYPE)]) {
      const m = parse(referrerManifest(a, subject));
      expect([m.artifactType, m.layers[0]!.mediaType]).toEqual([a.mediaType, a.mediaType]);
      expect(m.annotations).toEqual({ "org.opencontainers.image.title": a.name });
      expect(legacyReferrerManifest(a, subject)).toBeNull();
    }
    const old = parse(legacyReferrerManifest(file("scan", SCAN_FINDINGS_FILE, SCAN_FINDINGS_MEDIA_TYPE), subject)!);
    expect(old.artifactType).toBe(SCAN_FINDINGS_MEDIA_TYPE);
    expect(GITLAB_REGISTRY_TYPES.has(old.artifactType)).toBe(false);
  });

  test("a publish with the scan stages an image and its findings on a registry that refuses unknown artifact types", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-known-1", token: "tok-known-1" }, { knownTypes: GITLAB_REGISTRY_TYPES });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const scanner = { ...fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1"] }), database: async () => ({ version: "v6.0.2" }) };
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-known-1" } });
      const run = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets: [target!], ctx, record: false });
      const findings = run.published[0]!.items.find((i) => i.attachment === "scan")!;
      const manifest = parse(new Uint8Array(reg.manifests.get(findings.digest!)!.bytes));
      expect(manifest.annotations[CHANT_MEDIA_TYPE_ANNOTATION]).toBe(SCAN_FINDINGS_MEDIA_TYPE);
      expect(JSON.parse(reg.manifests.get(findings.digest!)!.bytes.toString("utf-8")).subject.digest).toBe(digest);
    } finally {
      await reg.close();
    }
  });

  test("a resumed stage keeps a findings referrer an earlier chant pushed in the old shape and does not attach a second", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-legacy-1", token: "tok-legacy-1" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      LOCK_CLEAN(dir);
      const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const scanner = { ...fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1"] }), database: async () => ({ version: "v6.0.2" }) };
      const ctx = context(dir, { scanner, policy: {}, vex: [] }, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-legacy-1" } });
      const run = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets: [target!], ctx, record: false });
      const pushed = run.published[0]!.items.find((i) => i.attachment === "scan")!;
      // What an earlier chant left: the same findings under the old manifest, and not the new one.
      const f = findingsAttachment(run.scan!, digest)!;
      const { subject: imageSubject } = JSON.parse(reg.manifests.get(pushed.digest!)!.bytes.toString("utf-8")) as { subject: { mediaType: string; digest: string; size: number } };
      const legacy = legacyReferrerManifest({ kind: "scan", ...f, digest: bytesDigest(f.bytes) }, imageSubject)!;
      const legacyDigest = bytesDigest(legacy);
      reg.manifests.delete(pushed.digest!);
      reg.manifests.set(legacyDigest, { name: "acme/api", type: "application/vnd.oci.image.manifest.v1+json", bytes: Buffer.from(legacy) });
      const again = await target!.stage({ ...ctx, scanReport: run.scan! });
      const kept = again.items.find((i) => i.attachment === "scan")!;
      expect(kept).toMatchObject({ digest: legacyDigest, present: true });
      expect(reg.manifests.has(pushed.digest!)).toBe(false);
    } finally {
      await reg.close();
    }
  });
});
