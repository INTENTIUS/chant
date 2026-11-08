import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import {
  CONFTEST_VERSION,
  installPolicyEngine,
  OPA_VERSION,
  pinnedPolicyEngineSha256,
  POLICY_ENGINE_INSTALL_FLOOR,
  POLICY_ENGINE_PLATFORMS,
  POLICY_ENGINE_SHA256,
  policyEngineBinary,
  policyEnginePlatform,
  policyEngineRelease,
  tarEntry,
} from "./policy-engine";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "policy-engine-"));
  scratch.push(d);
  return d;
};
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A ustar archive of `files`, as a release's `.tar.gz` holds them. */
function tarGz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf-8");
    h.write("0000755\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.fill(" ", 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A download that records what it was asked for and never reaches the network. */
function fakeDownload(bytes: Uint8Array): { download: (url: string) => Promise<Uint8Array>; urls: string[] } {
  const urls: string[] = [];
  return { urls, download: async (url) => (urls.push(url), bytes) };
}

describe("the pins (#4774)", () => {
  test("every platform has a sha256 for the default conftest and OPA", () => {
    for (const platform of POLICY_ENGINE_PLATFORMS) {
      for (const engine of ["conftest", "opa"] as const) {
        expect(pinnedPolicyEngineSha256(policyEngineRelease(engine, platform)), `${engine} ${platform}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(Object.keys(POLICY_ENGINE_SHA256)).toHaveLength(POLICY_ENGINE_PLATFORMS.length * 2);
    expect(POLICY_ENGINE_INSTALL_FLOOR).toBe("0.124.77");
  });

  test("the release files are the ones each project publishes", () => {
    expect(policyEngineRelease("conftest", "linux-x64").url).toBe(`https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz`);
    expect(policyEngineRelease("conftest", "darwin-arm64").asset).toBe(`conftest_${CONFTEST_VERSION}_Darwin_arm64.tar.gz`);
    expect(policyEngineRelease("opa", "linux-arm64").url).toBe(`https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_arm64_static`);
    expect(policyEngineRelease("opa", "darwin-x64").asset).toBe("opa_darwin_amd64");
    expect(policyEngineRelease("opa", "darwin-arm64").asset).toBe("opa_darwin_arm64_static");
    expect(() => policyEngineRelease("opa", "linux-x64", "latest")).toThrow(/not a release version/);
  });

  test("the platform comes from node's names, and one with no pin is refused", () => {
    expect(policyEnginePlatform("linux", "x64")).toBe("linux-x64");
    expect(policyEnginePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(policyEnginePlatform("linux", "aarch64")).toBe("linux-arm64");
    expect(() => policyEnginePlatform("win32", "x64")).toThrow(/put the engine on PATH/);
  });
});

describe("installPolicyEngine (#4774)", () => {
  test("unpacks conftest from its archive into the cache, once", async () => {
    const cache = tmp();
    const archive = tarGz({ LICENSE: "license", "README.md": "readme", conftest: "#!/bin/sh\necho conftest\n" });
    const fake = fakeDownload(archive);
    const options = { cache, platform: "linux-x64" as const, version: "9.9.9", sha256: { "linux-x64": sha(archive) }, download: fake.download };
    const bin = await installPolicyEngine("conftest", options);
    expect(bin).toBe(join(cache, "conftest-9.9.9-linux-x64", "conftest"));
    expect(readFileSync(bin, "utf-8")).toBe("#!/bin/sh\necho conftest\n");
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(fake.urls).toEqual(["https://github.com/open-policy-agent/conftest/releases/download/v9.9.9/conftest_9.9.9_Linux_x86_64.tar.gz"]);
    expect(await installPolicyEngine("conftest", options)).toBe(bin);
    expect(fake.urls).toHaveLength(1);
    expect(readdirSync(join(cache, "conftest-9.9.9-linux-x64"))).toEqual(["conftest"]);
  });

  test("takes OPA's bare binary as it is", async () => {
    const cache = tmp();
    const body = new Uint8Array(Buffer.from("opa binary"));
    const fake = fakeDownload(body);
    const bin = await installPolicyEngine("opa", { cache, platform: "darwin-arm64", version: "1.0.0", sha256: { "darwin-arm64": sha(body) }, download: fake.download });
    expect(readFileSync(bin, "utf-8")).toBe("opa binary");
    expect(fake.urls).toEqual(["https://github.com/open-policy-agent/opa/releases/download/v1.0.0/opa_darwin_arm64_static"]);
  });

  test("checks the default release against chant's pin, and keeps nothing that does not match", async () => {
    const cache = tmp();
    const fake = fakeDownload(new Uint8Array(Buffer.from("not opa")));
    await expect(installPolicyEngine("opa", { cache, platform: "linux-x64", download: fake.download })).rejects.toThrow(
      new RegExp(`opa ${OPA_VERSION} from .*opa_linux_amd64_static does not match its pinned sha256 \\(want ${POLICY_ENGINE_SHA256[`opa-${OPA_VERSION}-linux-x64`]}`),
    );
    expect(fake.urls).toHaveLength(1);
    expect(readdirSync(cache)).toEqual([]);
  });

  test("fetches nothing for a release with no pin", async () => {
    const fake = fakeDownload(new Uint8Array());
    await expect(installPolicyEngine("conftest", { cache: tmp(), platform: "linux-arm64", version: "0.1.0", download: fake.download })).rejects.toThrow(/records no sha256 for conftest 0.1.0 on linux-arm64/);
    await expect(installPolicyEngine("conftest", { cache: tmp(), platform: "linux-arm64", version: "0.1.0", sha256: { "linux-x64": "a".repeat(64) }, download: fake.download })).rejects.toThrow(/records no sha256/);
    expect(fake.urls).toEqual([]);
  });

  test("an archive without the binary is refused", async () => {
    const cache = tmp();
    const archive = tarGz({ "README.md": "readme" });
    await expect(installPolicyEngine("conftest", { cache, platform: "linux-x64", version: "9.9.9", sha256: { "linux-x64": sha(archive) }, download: fakeDownload(archive).download })).rejects.toThrow(/holds no conftest binary/);
    expect(existsSync(join(cache, "conftest-9.9.9-linux-x64", "conftest"))).toBe(false);
  });
});

describe("policyEngineBinary (#4774)", () => {
  test("uses the engine on PATH when it answers, and the pinned release otherwise", async () => {
    const body = new Uint8Array(Buffer.from("opa"));
    const fake = fakeDownload(body);
    const pin = { platform: "linux-x64" as const, version: "1.0.0", sha256: { "linux-x64": sha(body) }, download: fake.download };
    expect(await policyEngineBinary("opa", { ...pin, cache: tmp(), probe: () => true })).toBe("opa");
    expect(fake.urls).toEqual([]);
    const cache = tmp();
    expect(await policyEngineBinary("opa", { ...pin, cache, probe: () => false })).toBe(join(cache, "opa-1.0.0-linux-x64", "opa"));
    expect(await policyEngineBinary("opa", { ...pin, cache: tmp(), probe: () => true, pinnedOnly: true })).toMatch(/opa-1\.0\.0-linux-x64\/opa$/);
    expect(fake.urls).toHaveLength(2);
  });
});

describe("tarEntry", () => {
  test("finds a file at the top or under ./, and nothing else", async () => {
    const { gunzipSync } = await import("node:zlib");
    const tar = gunzipSync(tarGz({ "./conftest": "a", "sub/conftest": "b" }));
    expect(Buffer.from(tarEntry(tar, "conftest")!).toString()).toBe("a");
    expect(tarEntry(gunzipSync(tarGz({ "sub/conftest": "b" })), "conftest")).toBeUndefined();
  });
});
