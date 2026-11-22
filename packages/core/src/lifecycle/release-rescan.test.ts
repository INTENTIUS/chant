/**
 * #5466: a published release scanned again. The publish runs against a
 * registry fake with a scanner fixture whose database holds no critical
 * finding for the image; the rescan then runs with a fixture database that
 * has gained one, and the finding is recorded beside the publish's scan.
 * Nothing reaches a real registry, scanner or forge.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { appendPublishRecord, readPublishRecords, type PublishRecord } from "./publish-record";
import { scanBeforeStage } from "./publish-scan";
import { createPublishTargets } from "./publish-targets";
import { deployedReleases, newestScans, recordedSboms, rescanRelease, scanLines } from "./release-rescan";
import { scanRecorded } from "./release-supply-gate";
import { cutRelease } from "./release-cut";
import { appendReleaseRecord } from "./release-ledger";
import type { PublishContext } from "./release-publish";
import type { ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { startFakeRegistry, writeLockfile, writeOciLayout } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner, SCAN_ADVISORIES } from "./__fixtures__/scan-fakes";

const LATER = join(__dirname, "__fixtures__", "scan-advisories-later.json");
const PATCHED = ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"];

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

/** A repository with a cut release, and an image of it pushed to the registry fake with the SBOM of its layers. */
async function published(label: string) {
  const reg = await startFakeRegistry({ username: "robot", password: `pw-${label}`, token: `tok-${label}` });
  const r = new TestRepo(`rescan-${label}`);
  repos.push(r);
  r.write("chant.config.ts", 'export default { environments: ["dev", "prod"], release: { publish: [] } };\n');
  r.write("api.component.ts", "export const api = {};\n");
  writeLockfile(r.dir);
  const { digest } = writeOciLayout(join(r.dir, "image"));
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const cut = (await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, now: () => new Date("2026-10-17T10:00:00.000Z") })) as unknown as { release: PublishContext["release"] };
  const release = cut.release;
  const repository = `${reg.host}/acme/api`;
  const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository })], {});
  const env = { OCI_USERNAME: "robot", OCI_PASSWORD: `pw-${label}` };
  const scanner = fakeReleaseScanner({ image: PATCHED });
  const ctx: PublishContext = { release, label: "v1", releaseTag: "release/v1", provenance: { oidc: true, ci: "github", reason: "" }, cwd: r.dir, tag: null, env, redactor: createRedactor(env), log: () => undefined, scan: { scanner, policy: {}, vex: [] } };
  const report = await scanBeforeStage({ targets: [target!], ctx, scan: ctx.scan! });
  const staged = await target!.stage({ ...ctx, scanReport: report });
  const line = (step: PublishRecord["step"], over: Partial<PublishRecord> = {}) =>
    appendPublishRecord({ version: 1, releaseDigest: release.releaseDigest, label: "v1", target: target!.key, kind: "oci", name: target!.name, step, items: staged.items, state: {}, runId: "1", timestamp: "2026-10-17T11:00:00.000Z", ...over }, createRedactor({}), { cwd: r.dir });
  await line("revealed");
  return { reg, r, release, repository, imageDigest: digest, env, line };
}

describe("a rescan", () => {
  test("fetches the SBOM the publish attached, by digest, and records a finding the database gained since", async () => {
    const p = await published("one");
    try {
      const redactor = createRedactor(p.env);
      const before = p.reg.requests.length;
      const found = await recordedSboms({ cwd: p.r.dir, releaseDigest: p.release.releaseDigest, env: p.env, redactor });
      expect(found.skipped).toEqual([]);
      expect(found.subjects).toHaveLength(1);
      expect(found.subjects[0]).toMatchObject({ name: `${p.repository}@${p.imageDigest}`, digest: p.imageDigest });
      expect(found.subjects[0]!.sbom!.bytes).toContain("openssl");

      // The publish's database knew nothing critical about this image; today's does.
      const clean = await rescanRelease({ cwd: p.r.dir, releaseDigest: p.release.releaseDigest, label: "v1", env: p.env, scan: { scanner: fakeReleaseScanner({ db: SCAN_ADVISORIES }), policy: {}, vex: [] } });
      expect(clean).toMatchObject({ blocked: false, nothingScanned: false });
      const later = await rescanRelease({
        cwd: p.r.dir,
        releaseDigest: p.release.releaseDigest,
        label: "v1",
        env: p.env,
        scan: { scanner: fakeReleaseScanner({ db: LATER }), policy: {}, vex: [] },
        deployed: ["prod"],
        now: () => new Date("2026-11-20T00:00:00.000Z"),
      });
      expect(later.blocked).toBe(true);
      expect(later.record.subjects[0]!.findings.map((f) => [f.id, f.outcome])).toEqual([
        ["CVE-2026-50003", "reported"],
        ["CVE-2026-50004", "severity-threshold"],
      ]);

      // Both rescans are lines of the publish record, after the scan that came with the publish, in order.
      const lines = scanLines(await readPublishRecords(p.release.releaseDigest, { cwd: p.r.dir }));
      expect(lines.map((l) => [l.step, l.blocked])).toEqual([["rescanned", false], ["rescanned", true]]);
      const written = (await readPublishRecords(p.release.releaseDigest, { cwd: p.r.dir })).filter((r) => r.step === "rescanned");
      expect(written[1]).toMatchObject({ kind: "scan", target: "scan", state: { deployed: "prod" }, timestamp: "2026-11-20T00:00:00.000Z" });
      // release list --json shows the newest of them.
      expect((await newestScans({ cwd: p.r.dir })).get(p.release.releaseDigest)).toMatchObject({ step: "rescanned", at: "2026-11-20T00:00:00.000Z", blocked: true, findings: 2, scanner: "fake-grype v0.0.1" });
      // Nothing was pushed to the registry: the rescans only read it.
      expect(p.reg.requests.slice(before).filter((r) => r.method !== "GET" && r.method !== "HEAD")).toEqual([]);
    } finally {
      await p.reg.close();
    }
  }, 60_000);

  test("a clean rescan after a stopped publish counts for promote, a blocked one does not, and a SBOM it can't fetch is said", async () => {
    const p = await published("two");
    try {
      const failedOnly = [{ kind: "scan", step: "scan-failed" }] as const;
      expect(scanRecorded(failedOnly)).toBe("failed-only");
      const subjects = [{ target: "t", name: "n", findings: [{ id: "CVE-1", severity: "low", package: "p", version: "1", outcome: "reported" as const }] }];
      const blocking = [{ ...subjects[0]!, findings: [{ ...subjects[0]!.findings[0]!, outcome: "severity-threshold" as const }] }];
      expect(scanRecorded([...failedOnly, { kind: "scan", step: "rescanned", scan: { scanner: "g", database: null, subjects } }])).toBe("passed");
      expect(scanRecorded([...failedOnly, { kind: "scan", step: "rescanned", scan: { scanner: "g", database: null, subjects: blocking } }])).toBe("failed-only");
      expect(scanRecorded([...failedOnly, { kind: "scan", step: "rescanned", scan: { scanner: "g", database: null, subjects: [] } }])).toBe("failed-only");

      // A forge release's SBOM is not fetched, and the record says so; an image with no recorded SBOM is said too.
      const records = await readPublishRecords(p.release.releaseDigest, { cwd: p.r.dir });
      const forge: PublishRecord = { ...records[0]!, kind: "forge", name: "forge github acme/api", target: "forge" };
      const bare: PublishRecord = { ...records[0]!, items: records[0]!.items.filter((i) => i.attachment !== "sbom") };
      const found = await recordedSboms({ cwd: p.r.dir, releaseDigest: p.release.releaseDigest, env: p.env, redactor: createRedactor(p.env), records: [forge, bare] });
      expect(found.subjects).toEqual([]);
      expect(found.skipped.map((s) => s.reason)).toEqual([expect.stringContaining("forge release's assets is not fetched"), "the publish recorded no SBOM for the image"]);
      const none = await rescanRelease({ cwd: p.r.dir, releaseDigest: "sha256:" + "f".repeat(64), label: null, env: p.env, scan: { scanner: fakeReleaseScanner(), policy: {}, vex: [] }, record: false });
      expect(none).toMatchObject({ nothingScanned: true, blocked: false });
    } finally {
      await p.reg.close();
    }
  }, 60_000);
});

describe("--deployed", () => {
  test("names the releases the newest deploy record of each environment holds, and no others", async () => {
    const r = new TestRepo("rescan-deployed");
    repos.push(r);
    r.write("chant.config.ts", 'export default { environments: ["dev", "prod"] };\n');
    r.commit("init");
    const rec = (env: string, releaseDigest: string | undefined, timestamp: string) => ({ component: "api", env, digest: `sha256:${"1".repeat(64)}`, gitSha: "a".repeat(40), runId: "1", timestamp, actor: "alice", ...(releaseDigest ? { releaseDigest } : {}) });
    const old = `sha256:${"a".repeat(64)}`;
    const current = `sha256:${"b".repeat(64)}`;
    const dev = `sha256:${"c".repeat(64)}`;
    const never = `sha256:${"d".repeat(64)}`;
    await appendReleaseRecord(rec("prod", old, "2026-10-01T00:00:00.000Z") as never, { cwd: r.dir });
    await appendReleaseRecord(rec("prod", current, "2026-11-01T00:00:00.000Z") as never, { cwd: r.dir });
    await appendReleaseRecord(rec("dev", dev, "2026-11-02T00:00:00.000Z") as never, { cwd: r.dir });
    await appendReleaseRecord({ ...rec("dev", undefined, "2026-11-03T00:00:00.000Z"), component: "worker" } as never, { cwd: r.dir });
    const all = await deployedReleases({ cwd: r.dir });
    expect([...all.keys()].sort()).toEqual([current, dev].sort());
    expect(all.has(old)).toBe(false);
    expect(all.has(never)).toBe(false);
    expect([...(await deployedReleases({ cwd: r.dir, env: "prod" })).keys()]).toEqual([current]);
  }, 60_000);
});
