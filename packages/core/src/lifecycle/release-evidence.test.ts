/**
 * #5465: `chant release evidence`. A fixture release with a sealed approval,
 * a signed cut, a scan, a publish to a registry fake and a deploy is
 * exported; the index names every file with its digest, the copied cut and
 * approval verify from the export alone, and a period with no release says
 * so. Nothing reaches a real registry, scanner, forge or signer.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { appendPublishRecord, type PublishRecord } from "./publish-record";
import { scanBeforeStage, scanRecord, SCAN_RECORD_TARGET } from "./publish-scan";
import { createPublishTargets } from "./publish-targets";
import { cutRelease } from "./release-cut";
import { appendReleaseRecord } from "./release-ledger";
import { appendLedgerLine, writeBlobToPath } from "./git";
import { checkEvidence, EVIDENCE_STATEMENT, exportEvidence, EvidenceExportError, SUMS_FILE } from "./release-evidence";
import type { PublishContext } from "./release-publish";
import type { ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { hasSshKeygen, TestRepo } from "../workspace/trust/test-repo";
import { sealGateApproval } from "../workspace/trust/seal";
import { startFakeRegistry, writeLockfile, writeOciLayout, type FakeRegistry } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner } from "./__fixtures__/scan-fakes";
import { contract } from "../workspace/__fixtures__/contract-repo";
import schema from "../workspace/release-evidence.schema.json";
import { EVIDENCE_KINDS } from "../workspace/evidence-kinds";
import { CONTROLS_OUTSIDE_BOTH_BASELINES, evidenceKindTable, SECURITY_CONTROLS } from "../workspace/security-controls";

const { expectValid } = contract(schema);

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const cleanup: string[] = [];
const registries: FakeRegistry[] = [];
afterAll(async () => {
  for (const r of registries) await r.close();
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const CHANGE_SET = `sha256:${"c".repeat(64)}`;
const ASSET = Buffer.from("the tarball");
const BUNDLE = Buffer.from('{"bundle":"fake"}');

/** A repository with a merged change, its sealed approval, a signed cut of it, a scanned publish to the registry fake and a deploy. */
async function fixture() {
  const reg = await startFakeRegistry({ username: "robot", password: "pw-evidence", token: "tok-evidence" });
  registries.push(reg);
  const r = new TestRepo("evidence");
  cleanup.push(dirname(r.dir));
  const alice = r.key("alice");
  r.write(".chant/allowed_signers", `alice ${alice.pub}\n`);
  r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { approver: ["alice"] } }));
  r.write("chant.config.ts", 'export default { environments: ["dev", "prod"], release: { publish: [] } };\n');
  r.write("api.component.ts", "export const api = {};\n");
  writeLockfile(r.dir);
  writeOciLayout(join(r.dir, "image"));
  const base = r.commit("base");
  r.write("api.component.ts", "export const api = { v: 2 };\n");
  const head = r.commit("feature");
  r.git(["tag", `ci/green/${head}`]);

  // The merge, its change set and the approval sealed by alice.
  await writeBlobToPath("_merges", `${head}.json`, `${JSON.stringify({ $schema: "https://intentius.io/chant/schemas/workspace/merge-record/v1/merge-record.schema.json", contract: 1, commit: head, base, env: "prod", source: { kind: "pull-request", pr: 7 }, op: "pr-7", gate: "deploy", digest: CHANGE_SET, plan: "approved", approvedBy: ["alice"], components: ["api"], recordedAt: "2026-10-17T09:00:00.000Z" })}\n`, "merge", { cwd: r.dir });
  await writeBlobToPath("_change-sets", `${CHANGE_SET.replace(":", "_")}.json`, `${JSON.stringify({ digest: CHANGE_SET, members: [] })}\n`, "change set", { cwd: r.dir });
  const approval = { op: "pr-7", gate: "deploy", planDigest: CHANGE_SET, resolvedBy: "alice", timestamp: "2026-10-17T08:30:00.000Z" };
  const seal = sealGateApproval(alice.file, approval);
  await appendLedgerLine("_gates", "pr-7.jsonl", JSON.stringify({ version: 1, kind: "resolution", ...approval, seal }), "approve", { cwd: r.dir });
  await appendLedgerLine("_gates", "pr-99.jsonl", JSON.stringify({ version: 1, kind: "resolution", op: "pr-99", gate: "deploy", resolvedBy: "bob", timestamp: "2020-01-01T00:00:00.000Z" }), "approve", { cwd: r.dir });

  // The signed cut.
  const cut = (await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, sign: alice.file, now: () => new Date("2026-10-17T10:00:00.000Z") })) as unknown as { release: PublishContext["release"] };
  const release = cut.release;

  // The publish: scanned before the stage, staged to the registry fake, revealed.
  const repository = `${reg.host}/acme/api`;
  const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository })], {});
  const env = { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-evidence" };
  const scanner = { ...fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] }), database: async () => ({ version: "v6.0.2", built: "2026-10-17T06:00:00Z" }) };
  const ctx: PublishContext = { release, label: "v1", releaseTag: "release/v1", provenance: { oidc: true, ci: "github", reason: "" }, cwd: r.dir, tag: null, env, redactor: createRedactor(env), log: () => undefined, scan: { scanner, policy: {}, vex: [] } };
  const report = await scanBeforeStage({ targets: [target!], ctx, scan: ctx.scan! });
  const staged = await target!.stage({ ...ctx, scanReport: report });
  const line = (step: PublishRecord["step"], over: Partial<PublishRecord> = {}) =>
    appendPublishRecord({ version: 1, releaseDigest: release.releaseDigest, label: "v1", target: target!.key, kind: "oci", name: target!.name, step, items: staged.items, state: {}, runId: "1", timestamp: "2026-10-17T11:00:00.000Z", ...over }, createRedactor({}), { cwd: r.dir });
  await line("scanned", { target: SCAN_RECORD_TARGET.key, kind: "scan", name: SCAN_RECORD_TARGET.name, items: [], scan: scanRecord(report) });
  await line("revealed", { runnerKey: "SHA256:host", crypto: { node: "22.0.0", openssl: "3.0.13", fips: false } as never });
  // A forge release beside the image: its bundle and SBOM are on the forge, named here by digest.
  const forgeItems = [
    { name: "api.tar.gz", destination: "https://forge.example.test/acme/api/releases/v1", digest: `sha256:${createHash("sha256").update(ASSET).digest("hex")}` },
    { name: "api.tar.gz.sigstore.json", destination: "https://forge.example.test/acme/api/releases/v1", digest: `sha256:${createHash("sha256").update(BUNDLE).digest("hex")}`, attachment: "signature" as const, signs: [{ name: "api.tar.gz", digest: "sha256:x" }] },
    { name: "api.spdx.json", destination: "https://forge.example.test/acme/api/releases/v1", digest: `sha256:${"9".repeat(64)}`, attachment: "sbom" as const },
  ];
  await line("revealed", { target: "forge", kind: "forge", name: "forge github acme/api", items: forgeItems });
  await appendReleaseRecord({ component: "api", env: "prod", digest: `sha256:${"1".repeat(64)}`, gitSha: head, runId: "2", timestamp: "2026-10-18T00:00:00.000Z", actor: "alice", releaseDigest: release.releaseDigest } as never, { cwd: r.dir });
  return { r, alice, reg, release, repository, env, head, base };
}

const out = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-evidence-out-"));
  cleanup.push(d);
  return join(d, "export");
};
const tipOf = (dir: string) => execFileSync("git", ["rev-parse", "refs/heads/chant/lifecycle"], { cwd: dir, encoding: "utf-8" }).trim();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!hasSshKeygen)("chant release evidence", () => {
  // One fixture for every test: each export reads it and writes only its own directory.
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  }, 120_000);

  test("a release exports its records with an index by control id, every file's digest, and checks from the export alone", async () => {
    const tip = tipOf(f.r.dir);
    const before = f.reg.requests.length;
    const dir = out();
    const { index, signedBy } = await exportEvidence({ cwd: f.r.dir, scope: { kind: "release", ref: "v1" }, outDir: dir, referrers: true, sign: f.alice.file, env: f.env, now: () => new Date("2026-11-21T00:00:00.000Z") });
    expectValid(index);
    expect(index.statement).toBe(EVIDENCE_STATEMENT);
    expect(index.releases).toEqual([expect.objectContaining({ releaseDigest: f.release.releaseDigest, label: "v1", commit: f.head, verify: "verified" })]);
    expect(index.noReleases).toBeUndefined();
    expect(signedBy).toMatch(/^SHA256:/);
    expect(index.problems).toEqual([]);
    expect([...new Set(index.files.flatMap((x) => x.records.map((k) => k.kind)))].sort()).toEqual(["change-set", "crypto", "cut", "deploy", "gate", "merge", "publish", "referrer-attestation", "referrer-sbom", "referrer-scan", "release", "runner-key", "sbom-record", "scan", "sealed-approval", "signature-record", "signers", "trust", "verify"]);

    // Every file the index names is there with its digest, and SHA256SUMS lists them all and the index.
    for (const file of index.files) expect(sha(readFileSync(join(dir, file.path))), file.path).toBe(file.sha256);
    const sums = readFileSync(join(dir, SUMS_FILE), "utf-8");
    for (const file of index.files) expect(sums).toContain(`${file.sha256}  ${file.path}\n`);
    expect(sums).toContain(`  index.json\n`);
    const paths = index.files.map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining([
      `lifecycle/_releases/${f.release.releaseDigest.replace(":", "_")}.json`,
      "lifecycle/_releases/cuts.jsonl",
      "lifecycle/_releases/publishes.jsonl",
      `lifecycle/_merges/${f.head}.json`,
      `lifecycle/_change-sets/${CHANGE_SET.replace(":", "_")}.json`,
      "lifecycle/_gates/pr-7.jsonl",
      "lifecycle/prod/releases.jsonl",
      `commits/${f.head}/.chant/trust.json`,
      `commits/${f.head}/.chant/allowed_signers`,
      `commits/${f.base}/.chant/allowed_signers`,
      `verify/${f.release.releaseDigest.replace(":", "_")}.json`,
    ]));
    // An approval of another change, outside the period of nothing, is not carried.
    expect(paths).not.toContain("lifecycle/_gates/pr-99.jsonl");
    // Referrers came from the registry fake, by digest.
    expect(index.files.some((x) => x.records.some((k) => k.kind === "referrer-sbom"))).toBe(true);

    // Ledger files are the branch's bytes.
    const branch = execFileSync("git", ["cat-file", "blob", `${tip}:_releases/cuts.jsonl`], { cwd: f.r.dir });
    expect(readFileSync(join(dir, "lifecycle/_releases/cuts.jsonl")).equals(branch)).toBe(true);
    const publishes = index.files.find((x) => x.path === "lifecycle/_releases/publishes.jsonl")!;
    expect(publishes.records.map((k) => k.kind).sort()).toEqual(["crypto", "publish", "runner-key", "sbom-record", "scan", "signature-record"]);

    // The controls, from the one table: found with the records that bear on them, or saying nothing was found.
    expect(index.controls.map((c) => c.id)).toEqual(SECURITY_CONTROLS.map((c) => c.id));
    const ra5 = index.controls.find((c) => c.id === "RA-5")!;
    expect(ra5.found).toBe(true);
    expect(ra5.records.map((x) => x.kind)).toEqual(expect.arrayContaining(["scan"]));
    expect(ra5.notShown).toBe(SECURITY_CONTROLS.find((c) => c.id === "RA-5")!.notShown);
    expect(index.controls.find((c) => c.id === "SC-13")!.records.map((x) => x.kind)).toEqual(expect.arrayContaining(["crypto", "trust"]));
    const cm6 = index.controls.find((c) => c.id === "CM-6")!;
    expect(cm6).toMatchObject({ found: false, records: [] });
    expect(cm6.absent).toContain("This export holds no record that bears on CM-6");
    const ca7 = index.controls.find((c) => c.id === "CA-7")!;
    expect(ca7.found).toBe(false);
    expect(ca7.absent).toContain("rescan");
    expect(index.outsideBothBaselines.map((c) => c.id)).toEqual(CONTROLS_OUTSIDE_BOTH_BASELINES.map((c) => c.id));

    // The wording never says a control is met.
    expect(readFileSync(join(dir, "index.json"), "utf-8")).not.toMatch(/\b(meets|satisfies|is compliant|are compliant)\b/i);

    // From the export alone: digests, the release file, the signed cut, the sealed approval and the signature on the sums.
    const check = await checkEvidence(dir);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.releases).toEqual([expect.objectContaining({ digestMatches: true })]);
    expect(check.cuts).toEqual([expect.objectContaining({ who: "alice", status: "verified" })]);
    expect(check.approvals).toEqual([expect.objectContaining({ who: "alice", status: "verified" })]);
    expect(check.signature).toMatchObject({ present: true, verified: true, key: signedBy, listedIn: expect.arrayContaining([`commits/${f.head}/.chant/allowed_signers`]) });

    // The export only read: chant/lifecycle did not move, and nothing was sent to the registry.
    expect(tipOf(f.r.dir)).toBe(tip);
    expect(f.reg.requests.slice(before).filter((q) => q.method !== "GET" && q.method !== "HEAD")).toEqual([]);

    // A changed file, or one added, is reported.
    writeFileSync(join(dir, "lifecycle/_releases/cuts.jsonl"), readFileSync(join(dir, "lifecycle/_releases/cuts.jsonl"), "utf-8").replace('"alice"', '"mallory"'));
    writeFileSync(join(dir, "extra.txt"), "x");
    const tampered = await checkEvidence(dir);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems).toEqual(expect.arrayContaining([expect.stringContaining("lifecycle/_releases/cuts.jsonl is "), "extra.txt is in the export and SHA256SUMS does not list it"]));
  }, 120_000);

  test("by default the export reads no registry, and says what it left out", async () => {
    const before = f.reg.requests.length;
    const { index } = await exportEvidence({ cwd: f.r.dir, scope: { kind: "release", ref: f.release.releaseDigest }, outDir: out(), env: f.env });
    expect(f.reg.requests.length).toBe(before);
    expect(index.files.some((x) => x.path.startsWith("referrers/"))).toBe(false);
    expect(index.notIncluded.map((n) => n.what)).toEqual(expect.arrayContaining([expect.stringContaining("image referrers"), expect.stringContaining("forge release assets"), expect.stringContaining("Sigstore check"), "chant release doctor results"]));
  }, 120_000);

  test("--assets copies the forge assets whose digests match, --sigstore records its check, and neither reaches a forge", async () => {
    const assets = mkdtempSync(join(tmpdir(), "chant-evidence-assets-"));
    cleanup.push(assets);
    writeFileSync(join(assets, "api.tar.gz.sigstore.json"), BUNDLE);
    writeFileSync(join(assets, "api.spdx.json"), "not the SBOM the publish uploaded");
    const verifier = { name: "fake-cosign", unavailable: () => null, calls: 0 } as never;
    const dir = out();
    const { index } = await exportEvidence({ cwd: f.r.dir, scope: { kind: "release", ref: "v1" }, outDir: dir, assetsDir: assets, sigstore: true, verifier, env: {} });
    const copied = index.files.filter((x) => x.records.some((k) => k.kind === "forge-asset")).map((x) => x.path);
    expect(copied).toEqual([`assets/${f.release.releaseDigest.replace(":", "_")}/api.tar.gz.sigstore.json`]);
    expect(index.problems).toEqual(expect.arrayContaining([expect.stringContaining("api.spdx.json in the assets directory is sha256:")]));
    expect(index.releases[0]).toMatchObject({ sigstoreFile: `verify/${f.release.releaseDigest.replace(":", "_")}.sigstore.json` });
    expect(index.files.some((x) => x.records.some((k) => k.kind === "sigstore-verify"))).toBe(true);
    expect((await checkEvidence(dir)).ok).toBe(true);
  }, 60_000);

  test("a period takes the releases cut in it, and a period with none says so plainly", async () => {
    const inside = await exportEvidence({ cwd: f.r.dir, scope: { kind: "period", since: "2026-10-01", until: "2026-11-01" }, outDir: out() });
    expect(inside.index.releases.map((x) => x.label)).toEqual(["v1"]);

    const dir = out();
    const empty = await exportEvidence({ cwd: f.r.dir, scope: { kind: "period", since: "2025-01-01", until: "2025-02-01" }, outDir: dir });
    expectValid(empty.index);
    expect(empty.index.releases).toEqual([]);
    expect(empty.index.noReleases).toContain("No release of this member was cut between 2025-01-01 and 2025-02-01");
    for (const c of empty.index.controls) {
      expect(c.found, c.id).toBe(false);
      expect(c.absent, c.id).toContain(`no record that bears on ${c.id}`);
    }
    expect((await checkEvidence(dir)).ok).toBe(true);
    // The old approval of another change falls in a period that covers it.
    const old = await exportEvidence({ cwd: f.r.dir, scope: { kind: "period", since: "2019-12-01", until: "2020-02-01" }, outDir: out() });
    expect(old.index.files.map((x) => x.path)).toContain("lifecycle/_gates/pr-99.jsonl");
  }, 120_000);

  test("refuses a directory that holds files, a release it can't find and a period backwards", async () => {
    const full = out();
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "x"), "x");
    const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as EvidenceExportError).code;
    expect(await code(exportEvidence({ cwd: f.r.dir, scope: { kind: "release", ref: "v1" }, outDir: full }))).toBe("evidence-out-not-empty");
    expect(await code(exportEvidence({ cwd: f.r.dir, scope: { kind: "release", ref: "v9" }, outDir: out() }))).toBe("evidence-release-not-found");
    expect(await code(exportEvidence({ cwd: f.r.dir, scope: { kind: "period", since: "2026-11-01", until: "2026-10-01" }, outDir: out() }))).toBe("evidence-period-invalid");
  }, 120_000);
});

describe("the kinds and the control table", () => {
  test("every kind the export writes bears on some control, and every row names only kinds the export writes", () => {
    const claimed = new Set([...SECURITY_CONTROLS, ...CONTROLS_OUTSIDE_BOTH_BASELINES].flatMap((c) => c.records));
    for (const k of EVIDENCE_KINDS) expect(claimed.has(k), k).toBe(true);
    for (const k of claimed) expect(EVIDENCE_KINDS as readonly string[], k).toContain(k);
    expect((schema as { $defs: { kind: { enum: string[] } } }).$defs.kind.enum).toEqual([...EVIDENCE_KINDS]);
  });

  test("the evidence page carries the table of kinds the control table prints, and names the controls with no record", () => {
    const page = readFileSync(join(__dirname, "../../../../docs/src/content/docs/cli/release/evidence.mdx"), "utf-8");
    const table = /^\| Kind \| Where it is \| Bears on \|[^\n]*\n(?:\|[^\n]*\n)*/m.exec(page)?.[0].trimEnd();
    expect(table, "regenerate from evidenceKindTable()").toBe(evidenceKindTable());
    const none = SECURITY_CONTROLS.filter((c) => c.records.length === 0).map((c) => c.id);
    expect(page).toContain(`${none.slice(0, -1).join(", ")} and ${none.at(-1)} have no record in the export`);
  });
});
