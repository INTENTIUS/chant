/**
 * #5518: under `supply-chain`, an npm package must carry its SBOM, and the
 * publish refuses one that does not (`publish-sbom-missing`). The cut runs the
 * same check before it records or tags anything, so the label is not spent on
 * a release the publish would refuse. A lockfile is no source for it: the scan
 * reads an SBOM written from the lockfile, and nothing puts that into the
 * package. No scanner runs and no network is used.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cutRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import { readCuts, type ReleasePublish } from "./release-store";
import { checkDeclaredPackageSboms } from "./publish-npm";
import { PublishTargetError } from "./release-publish";
import type { ForgeChecksReader } from "./release-green";
import type { TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { fakeReleaseScanner, layerSpdx } from "./__fixtures__/scan-fakes";

const repos: TestRepo[] = [];
const scratch: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};

const NPM: ReleasePublish = { target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" };
const passing: ForgeChecksReader = async () => ({ green: true, forge: "github", checks: ["build", "test"] });
const LOCKFILE = `${JSON.stringify({ name: "acme-cli", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "acme-cli", version: "0.0.0" } } }, null, 2)}\n`;

/** A package at the root with a committed package-lock.json, under the groups `security` names, with `files` beside it. */
function project(o: { security?: string[]; target?: string; files?: Record<string, string> } = {}): TestRepo {
  const r = new TestRepo("release-cut-sbom");
  repos.push(r);
  if (o.security) r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [], security: o.security }, null, 2));
  r.write("package.json", JSON.stringify({ name: "acme-cli", version: "0.0.0" }, null, 2));
  r.write("package-lock.json", LOCKFILE);
  r.write("chant.config.ts", `export default { release: { publish: [${o.target ?? `{ type: "npm", packages: ["."] }`}] } };\n`);
  for (const [path, text] of Object.entries(o.files ?? {})) r.write(path, text);
  r.commit("init");
  return r;
}

const request = (r: TestRepo, extra: Partial<CutRequest> = {}): CutRequest => ({
  cwd: r.dir,
  compiler: noCompile,
  label: "1.0.0",
  actor: "alice",
  env: {},
  now: () => new Date("2026-11-22T12:00:00Z"),
  publishes: [NPM],
  forgeChecks: passing,
  npmPublished: () => true,
  publishDeps: { releaseScanner: fakeReleaseScanner(), npm: "chant-test-no-npm-here" },
  ...extra,
});

const tags = (r: TestRepo) => r.git(["tag", "--list"]).trim();

describe("an npm package's SBOM at the cut (#5518)", () => {
  test("under supply-chain, a package with only a lockfile refuses the cut with the publish's code, and nothing is recorded or tagged", async () => {
    const r = project({ security: ["supply-chain"] });
    const err = await cutRelease(request(r)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("publish-sbom-missing");
    expect((err as ReleaseCutError).message).toMatch(/^no release was cut: acme-cli \(\.\) carries no SBOM: npm keeps no file beside a package/);
    expect((err as ReleaseCutError).fix).toContain("npm sbom --omit dev");
    expect((await readCuts({ cwd: r.dir })).cuts).toEqual([]);
    expect(tags(r)).toBe("");
  });

  test("under supply-chain, a package that carries sbom.spdx.json is cut", async () => {
    const r = project({ security: ["supply-chain"], files: { "sbom.spdx.json": layerSpdx("acme-cli", []) } });
    const result = await cutRelease(request(r));
    expect(result.cut).not.toBeNull();
  });

  test("an SBOM the cut's build writes into the package counts, since the check runs after the build", async () => {
    const r = project({ security: ["supply-chain"] });
    const result = await cutRelease(request(r, { build: () => writeFileSync(join(r.dir, "sbom.spdx.json"), layerSpdx("acme-cli", [])) }));
    expect(result.cut).not.toBeNull();
  });

  test("sbom: false is not refused at the cut", async () => {
    const r = project({ security: ["supply-chain"], target: `{ type: "npm", packages: ["."], sbom: false }` });
    expect((await cutRelease(request(r))).cut).not.toBeNull();
  });

  test("without the group, a package with no SBOM is cut, as the publish publishes it without one", async () => {
    const r = project();
    expect((await cutRelease(request(r))).cut).not.toBeNull();
  });
});

describe("checkDeclaredPackageSboms (#5518)", () => {
  function dir(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "chant-npm-sbom-"));
    scratch.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "1.0.0", ...extra });
  const code = (f: () => void): string | null => {
    try {
      f();
      return null;
    } catch (err) {
      if (err instanceof PublishTargetError) return err.code;
      throw err;
    }
  };

  test("refuses a package with none when required, names it, and passes one that carries any of the three files", () => {
    const root = dir({ "a/package.json": pkg("@acme/a"), "b/package.json": pkg("@acme/b"), "b/sbom.cdx.json": JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }) });
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["b"] }], root, true))).toBeNull();
    expect(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["b", "a"] }], root, true)).toThrow(/@acme\/a \(a\) carries no SBOM/);
  });

  test("a named file the package does not hold is refused with or without the group; nothing else is checked without it", () => {
    const root = dir({ "a/package.json": pkg("@acme/a") });
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["a"] }], root, false))).toBeNull();
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["a"], sbom: "bom.json" }], root, false))).toBe("publish-sbom-missing");
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["a"], sbom: false }], root, true))).toBeNull();
  });

  test("an SBOM that is not SPDX or CycloneDX is refused as at the publish", () => {
    const root = dir({ "a/package.json": pkg("@acme/a"), "a/sbom.spdx.json": "{}" });
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["a"] }], root, true))).toBe("publish-sbom-invalid");
  });

  test("leaves to the publish's plan a package that is not there, has no readable package.json or is private, and other target types", () => {
    const root = dir({ "p/package.json": pkg("@acme/p", { private: true }), "bad/package.json": "{" });
    expect(code(() => checkDeclaredPackageSboms([{ type: "npm", packages: ["missing", "p", "bad"] }, { type: "forge", packages: ["p"] }], root, true))).toBeNull();
  });
});
