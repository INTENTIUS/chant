/**
 * #5470: chant reports the crypto module its digests and signatures run on:
 * Node, OpenSSL, FIPS mode and what fetches in it, and which cosign would
 * sign. `getFips` and the fetches are stubbed, so these run on any Node.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { doctorCommand } from "./cli/commands/doctor";
import { cosignBinary, cryptoModule, cryptoModuleBroken, cryptoRecord, describeCosignBinary, describeCryptoModule, pinnedCosign } from "./crypto-module";
import { releaseDoctor } from "./lifecycle/release-doctor";
import { TOOL_PINS } from "./tool-pins";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-crypto-"));
  dirs.push(d);
  return d;
};

const VERSIONS = { node: "v22.11.0", openssl: "3.0.15+quic" };

describe("cryptoModule", () => {
  test("FIPS mode off: the versions and the default provider, and nothing is fetched", () => {
    const r = cryptoModule({ getFips: () => 0, versions: VERSIONS, fetch: () => { throw new Error("not called"); } });
    expect(r).toEqual({ node: "v22.11.0", openssl: "3.0.15+quic", fips: false, fetches: null });
    expect(cryptoModuleBroken(r)).toBeNull();
    expect(describeCryptoModule(r)).toBe("Node v22.11.0 on OpenSSL 3.0.15+quic; FIPS mode off, so digests and runner-key signatures use OpenSSL's default provider");
  });

  test("FIPS mode on: each algorithm is fetched, and the line never calls the module validated", () => {
    const r = cryptoModule({ getFips: () => 1, versions: VERSIONS, fetch: (a) => { if (a === "ed25519") throw new Error("unsupported"); } });
    expect(r.fips).toBe(true);
    expect(r.fetches).toEqual({ sha256: { ok: true }, ecdsaP256: { ok: true }, ed25519: { ok: false, reason: "unsupported" } });
    expect(cryptoModuleBroken(r)).toBeNull();
    const line = describeCryptoModule(r);
    expect(line).toContain("FIPS mode on: SHA-256 fetches, ECDSA P-256 fetches and Ed25519 does not fetch under fips=yes");
    expect(line).toContain("is in its certificate and security policy");
    expect(line).not.toMatch(/\bis validated|compliant/);
  });

  test("FIPS mode on with no provider for SHA-256 is broken", () => {
    const r = cryptoModule({ getFips: () => 1, versions: VERSIONS, fetch: (a) => { if (a === "sha256") throw new Error("no fips provider"); } });
    expect(cryptoModuleBroken(r)).toBe("FIPS mode is on, and no loaded provider supplies SHA-256 (no fips provider) under fips=yes");
  });

  test("on this process it reads the real versions", () => {
    const r = cryptoModule();
    expect(r.node).toBe(process.version);
    expect(typeof r.fips).toBe("boolean");
  });
});

describe("cosignBinary", () => {
  test("a file whose digest is a pinned upstream cosign is named as that pin; another is a supplied build", () => {
    const sum = TOOL_PINS.cosign.platforms["linux/amd64"]!.sha256;
    expect(pinnedCosign(sum)).toBe(`cosign ${TOOL_PINS.cosign.version} linux/amd64`);
    const dir = temp();
    const file = join(dir, "cosign-fips");
    writeFileSync(file, "#!/bin/sh\n");
    const supplied = cosignBinary({ CHANT_COSIGN: file });
    expect(supplied).toMatchObject({ path: file, from: "CHANT_COSIGN", pinned: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(describeCosignBinary(supplied)).toContain("which is not the cosign chant pins: a build the job supplies");
    // A file that can't be read names no build.
    const unreadable = cosignBinary({ CHANT_COSIGN: file }, { read: () => { throw new Error("EACCES"); } });
    expect(unreadable).toMatchObject({ sha256: null, pinned: null, reason: expect.stringContaining("EACCES") });
  });

  test("cosign on PATH is found, and none on PATH is said", () => {
    const dir = temp();
    const file = join(dir, "cosign");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    expect(cosignBinary({ PATH: dir })).toMatchObject({ path: file, from: "PATH" });
    const none = cosignBinary({ PATH: temp() });
    expect(none).toMatchObject({ path: "cosign", sha256: null, reason: "there is no cosign on PATH" });
    expect(describeCosignBinary(none)).toContain("whose build can't be told");
  });

  test("a publish record keeps the module and the CHANT_COSIGN build", () => {
    const dir = temp();
    const file = join(dir, "cosign");
    writeFileSync(file, "x");
    expect(cryptoRecord({ CHANT_COSIGN: file }, { getFips: () => 1, versions: VERSIONS })).toEqual({
      node: "v22.11.0",
      openssl: "3.0.15+quic",
      fips: true,
      cosign: { path: file, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), pinned: null },
    });
    expect(cryptoRecord({}, { getFips: () => 0, versions: VERSIONS })).toEqual({ node: "v22.11.0", openssl: "3.0.15+quic", fips: false });
  });
});

describe("the doctors report the crypto module", () => {
  test("chant doctor shows the mode as crypto-module, a warning only when FIPS mode can't fetch", async () => {
    const dir = temp();
    const off = await doctorCommand(dir, { crypto: { getFips: () => 0, versions: VERSIONS } });
    expect(off.checks.find((c) => c.name === "crypto-module")).toEqual({ name: "crypto-module", status: "pass", message: expect.stringContaining("FIPS mode off") });
    const on = await doctorCommand(dir, { crypto: { getFips: () => 1, versions: VERSIONS, fetch: () => undefined } });
    expect(on.checks.find((c) => c.name === "crypto-module")?.message).toContain("FIPS mode on");
    const broken = await doctorCommand(dir, { crypto: { getFips: () => 1, versions: VERSIONS, fetch: (a) => { if (a === "ecdsa-p256") throw new Error("gone"); } } });
    expect(broken.checks.find((c) => c.name === "crypto-module")).toMatchObject({ status: "warn", message: expect.stringContaining("ECDSA P-256 (gone)") });
  });

  test("release doctor carries the module, and names the cosign build when the publish signs", async () => {
    const dir = temp();
    const forge = { type: "forge", forge: "github", repo: "acme/app", assets: [] } as never;
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", ACTIONS_ID_TOKEN_REQUEST_URL: "http://oidc.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", GITHUB_TOKEN: "x" };
    const fetch = (async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => "{}", json: async () => ({}) })) as never;
    const report = await releaseDoctor({
      cwd: dir,
      publish: [forge],
      env,
      releaseWorkflow: null,
      signing: true as never,
      deps: {
        fetch,
        signer: { name: "cosign", unavailable: () => null },
        crypto: { getFips: () => 1, versions: VERSIONS, fetch: () => undefined },
        cosignBinary: () => ({ path: "/opt/fips/cosign", from: "CHANT_COSIGN", sha256: "ab".repeat(32), pinned: null }),
      },
    });
    expect(report.crypto).toMatchObject({ node: "v22.11.0", fips: true });
    expect(report.targets.find((t) => t.kind === "crypto")).toBeUndefined();
    const build = report.targets.find((t) => t.kind === "signing")?.checks.find((c) => c.check === "signing-cosign-build");
    expect(build).toMatchObject({ status: "ok", message: expect.stringContaining("CHANT_COSIGN names /opt/fips/cosign") });

    const broken = await releaseDoctor({ cwd: dir, publish: [], env: {}, releaseWorkflow: null, deps: { crypto: { getFips: () => 1, versions: VERSIONS, fetch: () => { throw new Error("none"); } } } });
    expect(broken.targets.find((t) => t.kind === "crypto")?.checks).toEqual([expect.objectContaining({ check: "crypto-module", status: "warn" })]);
  });
});
