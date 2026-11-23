/**
 * #5446 (epic #5452): the cut runs the publish's scan before it records or
 * tags anything, so a release the scan refuses spends no label. The scanner
 * is the fake from ./__fixtures__/scan-fakes.ts, matched against a fixture
 * advisory database: a critical openssl 3.0.11-1 in the image and a critical
 * left-pad 1.3.0 in npm. No scanner runs and no network is used.
 *
 * What "nothing pushed" rests on: `chant release cut` pushes `chant/lifecycle`
 * and makes the tag only once `cutRelease` returns (cli/handlers/release.ts),
 * and a train pushes its tags in one push after every member's cut. So a cut
 * refused here, with no `chant/lifecycle` branch and no tag in the repository,
 * has nothing to push.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { cutRelease, planRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import type { ReleaseArtifact } from "./release-store";
import type { TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { writeOciLayout } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner, layerSpdx } from "./__fixtures__/scan-fakes";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};

const OCI = `{ type: "oci", image: "image", repository: "registry.example.test/acme/api" }`;
const NPM = `{ type: "npm", packages: ["pkg"] }`;

/** A member that publishes `targets`, with `release` settings beside them, committed. */
function project(targets: string[], release = "scan: true"): TestRepo {
  const r = new TestRepo("release-cut-scan");
  repos.push(r);
  r.write("chant.config.ts", `export default { release: { ${release ? `${release}, ` : ""}publish: [${targets.join(", ")}] } };\n`);
  r.write("pkg/package.json", `${JSON.stringify({ name: "@acme/core", version: "1.4.0" }, null, 2)}\n`);
  r.commit("init");
  return r;
}

/** The cut's request, its images built by writing an OCI layout as `chant release images` writes one. */
function request(r: TestRepo, scanner: ReturnType<typeof fakeReleaseScanner>, o: { lines?: string[]; built?: string[]; label?: string } = {}): CutRequest {
  return {
    cwd: r.dir,
    compiler: noCompile,
    label: o.label ?? "1.4.0",
    actor: "alice",
    env: {},
    green: "none",
    npmPublished: () => true,
    now: () => new Date("2026-11-22T12:00:00Z"),
    buildImages: (): ReleaseArtifact[] => {
      o.built?.push("images");
      const { digest } = writeOciLayout(join(r.dir, "image"));
      return [{ component: "api", kind: "image", path: "image", digest }];
    },
    publishDeps: { releaseScanner: scanner, npm: join(r.dir, "no-npm-here") },
    log: (line) => void o.lines?.push(line),
  };
}

const noLedger = (r: TestRepo) => spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: r.dir }).status !== 0;
const tags = (r: TestRepo) => r.git(["tag", "--list"]).trim();

async function refused(req: CutRequest): Promise<ReleaseCutError> {
  const err = await cutRelease(req).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
}

describe("the scan at the cut (#5446)", () => {
  test("a critical finding in a built image refuses the cut, naming it, with nothing recorded or tagged", async () => {
    const r = project([OCI]);
    const scanner = fakeReleaseScanner();
    const err = await refused(request(r, scanner));
    expect(err.code).toBe("publish-scan-failed");
    expect(err.message).toMatch(/^no release was cut: fake-grype v0\.0\.1 found 1 finding\(s\) the vulnerability policy blocks, so nothing was recorded, tagged or pushed:/);
    expect(err.message).toMatch(/registry\.example\.test\/acme\/api@sha256:[0-9a-f]{64}: CVE-2026-50002 \(critical\) in debian\/openssl 3\.0\.11-1, fixed in 3\.0\.15-1/);
    // The low zlib finding does not block, as at the publish.
    expect(err.message).not.toContain("CVE-2026-50003");
    expect(err.fix).toContain("The label is not spent.");
    // The image the cut just built was scanned through an SBOM of its layers.
    expect(scanner.calls[0]).toBe(`image ${join(r.dir, "image")}`);
    expect(scanner.calls.slice(1)).toEqual(["scan syft"]);
    expect(noLedger(r)).toBe(true);
    expect(tags(r)).toBe("");
  });

  test("a critical finding in the SBOM an npm package carries refuses the cut the same way", async () => {
    const r = project([NPM]);
    r.write("pkg/sbom.spdx.json", layerSpdx("core", ["pkg:npm/left-pad@1.3.0"]));
    r.commit("the package's SBOM");
    const scanner = fakeReleaseScanner();
    const err = await refused({ ...request(r, scanner), buildImages: undefined, publishes: [{ target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" }] });
    expect(err.code).toBe("publish-scan-failed");
    expect(err.message).toContain("sbom.spdx.json of @acme/core@1.4.0: CVE-2026-50001 (critical) in left-pad 1.3.0, fixed in 1.3.1");
    expect(scanner.calls).toEqual(["scan carried"]);
    expect(noLedger(r)).toBe(true);
    expect(tags(r)).toBe("");
  });

  test("a clean scan cuts as before, and says what it scanned", async () => {
    const r = project([OCI]);
    const scanner = fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] });
    const lines: string[] = [];
    const result = await cutRelease(request(r, scanner, { lines }));
    expect(result.cut).not.toBeNull();
    expect(result.label).toBe("1.4.0");
    expect(noLedger(r)).toBe(false);
    expect(lines).toContain("  scanning with fake-grype v0.0.1 before anything is recorded or tagged");
    expect(lines.some((l) => /scanned registry\.example\.test\/acme\/api@sha256:[0-9a-f]{64}: 1 finding\(s\), none blocks/.test(l))).toBe(true);
  });

  test("a project that does not scan cuts as before and runs no scanner, even one that is not there", async () => {
    const r = project([OCI], "");
    const scanner = fakeReleaseScanner({ missing: "grype is not there" });
    const result = await cutRelease(request(r, scanner));
    expect(result.cut).not.toBeNull();
    expect(scanner.calls).toEqual([]);
  });

  test("release.scan: false turns it off, as for the publish", async () => {
    const r = project([OCI], "scan: false");
    const scanner = fakeReleaseScanner();
    expect((await cutRelease(request(r, scanner))).cut).not.toBeNull();
    expect(scanner.calls).toEqual([]);
  });

  test("a scanner that can't run refuses the cut and its dry run before any image is built", async () => {
    const r = project([OCI]);
    const scanner = fakeReleaseScanner({ missing: "grype is not there: install grype on PATH, or set CHANT_GRYPE to it" });
    for (const run of [planRelease, cutRelease] as const) {
      const built: string[] = [];
      const err = await run(request(r, scanner, { built })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseCutError);
      expect((err as ReleaseCutError).code).toBe("publish-scan-tool-missing");
      expect((err as ReleaseCutError).message).toBe("no release was cut: 1.4.0 would be scanned for known vulnerabilities before anything is pushed, as release.scan in chant.config.ts asks, and grype is not there: install grype on PATH, or set CHANT_GRYPE to it");
      expect(built).toEqual([]);
    }
    expect(noLedger(r)).toBe(true);
  });

  test("a VEX file vulnPolicy.vexSources names that is not there refuses the cut", async () => {
    const r = new TestRepo("release-cut-scan-vex");
    repos.push(r);
    r.write("chant.config.ts", `export default { vulnPolicy: { vexSources: ["vex/missing.json"] }, release: { scan: true, publish: [${OCI}] } };\n`);
    r.commit("init");
    const err = await refused(request(r, fakeReleaseScanner()));
    expect(err.code).toBe("publish-scan-vex-missing");
    expect(err.message).toContain("vulnPolicy.vexSources names vex/missing.json, which is not there");
  });

  test("a VEX statement clears a finding at the cut as it does at the publish", async () => {
    const r = new TestRepo("release-cut-scan-vex-clear");
    repos.push(r);
    r.write("chant.config.ts", `export default { vulnPolicy: { vexSources: ["vex.json"] }, release: { scan: true, publish: [${OCI}] } };\n`);
    r.write("vex.json", JSON.stringify({ "@context": "https://openvex.dev/ns/v0.2.0", statements: [{ vulnerability: { name: "CVE-2026-50002" }, products: [{ "@id": "registry.example.test/acme/api" }], status: "not_affected", justification: "vulnerable_code_not_in_execute_path" }] }));
    r.commit("init");
    expect((await cutRelease(request(r, fakeReleaseScanner()))).cut).not.toBeNull();
  });

  test("a VEX statement with no products clears nothing at the cut, and the cut says so", async () => {
    const r = new TestRepo("release-cut-scan-vex-unscoped");
    repos.push(r);
    r.write("chant.config.ts", `export default { vulnPolicy: { vexSources: ["vex.json"] }, release: { scan: true, publish: [${OCI}] } };\n`);
    r.write("vex.json", JSON.stringify({ statements: [{ vulnerability: { name: "CVE-2026-50002" }, status: "not_affected" }] }));
    r.commit("init");
    const lines: string[] = [];
    const err = await refused(request(r, fakeReleaseScanner(), { lines }));
    expect(err.code).toBe("publish-scan-failed");
    expect(lines.some((l) => l.includes("vex.json#statements[0] (CVE-2026-50002) is not applied"))).toBe(true);
  });

  test("a database older than release.scan.dbMaxAgeHours refuses the cut with the publish's code", async () => {
    const r = project([OCI], "scan: { dbMaxAgeHours: 24 }");
    const scanner = { ...fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1"] }), database: async () => ({ version: "v6.0.2", built: "2026-11-19T00:00:00Z" }) };
    const err = await refused(request(r, scanner as ReturnType<typeof fakeReleaseScanner>));
    expect(err.code).toBe("publish-scan-db-stale");
    expect(err.message).toMatch(/^no release was cut: .*, so nothing was recorded, tagged or pushed$/);
    expect(noLedger(r)).toBe(true);
  });

  test("a target whose subjects can't be read at the cut is left to the publish's scan, and the cut goes on", async () => {
    const r = project([OCI, `{ type: "npm", packages: ["not-a-package"] }`]);
    const lines: string[] = [];
    const scanner = fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1"] });
    const result = await cutRelease(request(r, scanner, { lines }));
    expect(result.cut).not.toBeNull();
    expect(lines.some((l) => l.includes("not scanned at the cut, so the publish scans it") && l.includes("[publish-file-missing]"))).toBe(true);
  });
});
