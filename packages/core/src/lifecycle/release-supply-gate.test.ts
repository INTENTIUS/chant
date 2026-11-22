/**
 * #5467: under `supply-chain`, promote deploys a release only after its image
 * signatures verify and its publish record holds a passing scan. The gate
 * runs against a temp repository, a fake cosign verifier and publish record
 * lines written by hand; nothing reaches a registry or Sigstore.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { COSIGN_SIGN_PREDICATE, SLSA_PROVENANCE_PREDICATE, type SigstoreVerifier } from "./publish-signing";
import { appendPublishRecord, type PublishRecord } from "./publish-record";
import { scanRecorded, supplyChainGate } from "./release-supply-gate";
import { cutRelease } from "./release-cut";
import type { ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";

const IDENTITY = { issuer: "https://token.actions.githubusercontent.com", identity: "^https://github\\.com/acme/api/" };
const GROUPS = new Set(["supply-chain"] as const);

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

/** A verifier that fails the image whose reference holds `bad`, and records each check. */
function verifier(bad?: string): SigstoreVerifier & { checked: string[] } {
  const checked: string[] = [];
  const check = async (ref: string) => {
    checked.push(ref);
    return bad && ref.includes(bad) ? "no matching signature" : null;
  };
  return {
    name: "fake-cosign",
    checked,
    unavailable: () => null,
    verifyBlob: async () => null,
    verifyBlobAttestation: async () => null,
    verifyImage: check,
    verifyImageAttestation: check,
  };
}

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

/** A repository whose config publishes an image, and its cut release. */
async function member(publish: string, extra = "") {
  const r = new TestRepo("supply-gate");
  repos.push(r);
  r.write("chant.config.ts", `export default { environments: ["dev"], release: { ${extra} publish: [${publish}] } };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const { release } = (await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, now: () => new Date("2026-10-17T10:00:00.000Z") })) as unknown as { release: { releaseDigest: string } };
  return { r, digest: release.releaseDigest };
}

const OCI = `{ type: "oci", image: "image.tar", repository: "ghcr.io/acme/api" }`;
const FORGE = `{ type: "forge", forge: "github", repo: "acme/api", assets: ["dist/api.tar.gz"] }`;

async function line(cwd: string, releaseDigest: string, step: PublishRecord["step"], over: Partial<PublishRecord> = {}) {
  const record: PublishRecord = { version: 1, releaseDigest, label: "v1", target: "oci", kind: "oci", name: "oci ghcr.io/acme/api", step, items: [], state: {}, runId: "1", timestamp: "2026-10-17T11:00:00.000Z", ...over };
  await appendPublishRecord(record, createRedactor({}), { cwd });
}

const image = (digest: string, predicateType: string, attachment: "signature" | "attestation") => ({
  name: attachment === "signature" ? "cosign signature" : "SLSA provenance",
  destination: "ghcr.io/acme/api, a referrer of the image",
  digest: `sha256:${"b".repeat(64)}`,
  attachment,
  signs: [{ name: `ghcr.io/acme/api@${digest}`, digest }],
  predicateType,
  sigstore: IDENTITY,
});

describe("the supply-chain gate on promote", () => {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  let m: Awaited<ReturnType<typeof member>>;
  beforeAll(async () => {
    m = await member(OCI, "signing: true, scan: true,");
  }, 120_000);

  test("does nothing without the supply-chain group", async () => {
    expect(await supplyChainGate({ cwd: m.r.dir, releaseDigest: m.digest, label: "v1", groups: new Set(), verifier: verifier() })).toBeNull();
  });

  test("refuses a release whose publish recorded no signature, then one whose bundle fails, and deploys one that verifies", async () => {
    const ask = (v: SigstoreVerifier) => supplyChainGate({ cwd: m.r.dir, releaseDigest: m.digest, label: "v1", groups: GROUPS, verifier: v });
    expect(await ask(verifier())).toMatchObject({ code: "release-sigstore-unsigned", hint: expect.stringContaining("chant release verify v1 --sigstore") });

    await line(m.r.dir, m.digest, "revealed", { items: [image(imageDigest, COSIGN_SIGN_PREDICATE, "signature"), image(imageDigest, SLSA_PROVENANCE_PREDICATE, "attestation")] });
    await line(m.r.dir, m.digest, "scanned", { target: "scan", kind: "scan", name: "scan" });
    expect(await ask(verifier(imageDigest))).toMatchObject({ code: "release-sigstore-unverified", message: expect.stringContaining("no matching signature") });

    const ok = verifier();
    expect(await ask(ok)).toBeNull();
    expect(ok.checked).toEqual([`ghcr.io/acme/api@${imageDigest}`, `ghcr.io/acme/api@${imageDigest}`]);
  });
});

describe("the scan record", () => {
  test("a release with no scan line, or only a blocked one, is refused, and a scanned one passes", async () => {
    const { r, digest } = await member(OCI, "signing: false, scan: true,");
    const ask = () => supplyChainGate({ cwd: r.dir, releaseDigest: digest, label: "v1", groups: GROUPS, verifier: verifier() });
    expect(await ask()).toMatchObject({ code: "release-scan-missing", message: expect.stringContaining("has no scan line") });
    await line(r.dir, digest, "scan-failed", { target: "scan", kind: "scan", name: "scan" });
    expect(await ask()).toMatchObject({ code: "release-scan-missing", message: expect.stringContaining("blocked") });
    await line(r.dir, digest, "scanned", { target: "scan", kind: "scan", name: "scan" });
    expect(await ask()).toBeNull();
  }, 60_000);

  test("signing: false and scan: false turn each check off, and a target that is neither signed nor scanned has nothing to check", async () => {
    const off = await member(OCI, "signing: false, scan: false,");
    expect(await supplyChainGate({ cwd: off.r.dir, releaseDigest: off.digest, label: "v1", groups: GROUPS, verifier: verifier() })).toBeNull();
    const none = await member("");
    expect(await supplyChainGate({ cwd: none.r.dir, releaseDigest: none.digest, label: "v1", groups: GROUPS, verifier: verifier() })).toBeNull();
    // A forge release is checked for a recorded signature; its files' bundles stay with release verify --assets.
    const forge = await member(FORGE);
    expect(await supplyChainGate({ cwd: forge.r.dir, releaseDigest: forge.digest, label: "v1", groups: GROUPS, verifier: verifier() })).toMatchObject({ code: "release-sigstore-unsigned" });
  }, 60_000);

  test("scanRecorded reads the newest meaning of the lines", () => {
    expect(scanRecorded([])).toBe("none");
    expect(scanRecorded([{ kind: "oci", step: "revealed" }])).toBe("none");
    expect(scanRecorded([{ kind: "scan", step: "scan-failed" }])).toBe("failed-only");
    expect(scanRecorded([{ kind: "scan", step: "scan-failed" }, { kind: "scan", step: "scanned" }])).toBe("passed");
  });
});
