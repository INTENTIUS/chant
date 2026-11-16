/**
 * #5233: Helm charts chant packs itself, and Linux packages nfpm builds, as
 * `release.artifacts` entries. nfpm is a stand-in that writes its target;
 * no helm or nfpm runs.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildReleaseArtifacts, checkReleaseArtifacts, helmIgnored, helmIgnoreRules, nfpmConfigVersion, ReleaseArtifactError, usesNfpm, type ReleaseArtifactDeclaration } from "./release-artifacts";
import { readChartArchive } from "./publish-helm";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function member(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "chant-5233-"));
  dirs.push(d);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  return d;
}

const EPOCH = 1_760_000_000;
const CHART = "apiVersion: v2\nname: api\ndescription: The API\nversion: 0.1.0 # bumped by the release\nappVersion: \"0.0.0\"\n";

const refusal = (fn: () => unknown): ReleaseArtifactError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReleaseArtifactError) return err;
    throw err;
  }
  throw new Error("not refused");
};

describe("helm entries (#5233)", () => {
  test("packs the chart under its name with the label's version, leaving out what .helmignore names, to the same bytes twice", () => {
    const cwd = member({
      "deploy/chart/Chart.yaml": CHART,
      "deploy/chart/values.yaml": "replicas: 1\n",
      "deploy/chart/templates/deployment.yaml": "kind: Deployment\n",
      "deploy/chart/templates/.scratch": "left out by helm's default\n",
      "deploy/chart/README.md": "left out\n",
      "deploy/chart/ci/values.yaml": "left out\n",
      "deploy/chart/charts/db-1.0.0.tgz": "a subchart\n",
      "deploy/chart/.helmignore": "# comment\n*.md\nci/\n",
    });
    const decls: ReleaseArtifactDeclaration[] = [{ name: "chart", helm: { chart: "deploy/chart", appVersion: true } }];
    const [file] = buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0" });
    expect(file).toMatchObject({ component: "chart", kind: "asset", path: "dist/api-1.4.0.tgz" });
    const listing = execFileSync("tar", ["-tzf", join(cwd, file!.path)], { encoding: "utf-8" }).trim().split("\n");
    expect(listing).toEqual(["api/Chart.yaml", "api/.helmignore", "api/charts/db-1.0.0.tgz", "api/templates/deployment.yaml", "api/values.yaml"]);
    const chart = readChartArchive(file!.path, new Uint8Array(readFileSync(join(cwd, file!.path))));
    expect(chart).toMatchObject({ name: "api", version: "1.4.0", metadata: { appVersion: "v1.4.0", description: "The API" } });
    // The comment after version stays: only the value changes.
    const yaml = execFileSync("tar", ["-xzOf", join(cwd, file!.path), "api/Chart.yaml"], { encoding: "utf-8" });
    expect(yaml).toContain("version: 1.4.0 # bumped by the release");
    const again = buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0" });
    expect(again[0]!.digest).toBe(file!.digest);
  });

  test("refuses a directory with no Chart.yaml, a cut with no label, and a ** in .helmignore", () => {
    const cwd = member({ "chart/values.yaml": "a: 1\n", "c2/Chart.yaml": CHART, "c2/.helmignore": "**/x\n" });
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "c", helm: { chart: "chart" } }], cwd, sourceDateEpoch: EPOCH, label: "v1.0.0" })).code).toBe("release-artifact-no-output");
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "c", helm: { chart: "c2" } }], cwd, sourceDateEpoch: EPOCH, label: null })).code).toBe("release-artifact-no-label");
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "c", helm: { chart: "c2" } }], cwd, sourceDateEpoch: EPOCH, label: "v1.0.0" })).message).toMatch(/\*\*/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "c", helm: { chart: "../elsewhere" } }])).code).toBe("release-artifact-outside");
  });

  test("helm's ignore rules: a bare name matches the last segment, a path the whole path, a trailing / only directories", () => {
    const rules = helmIgnoreRules("*.tmp\nsecrets/\n/docs/*.md\n", "x");
    expect(helmIgnored(rules, "templates/a.tmp", false)).toBe(true);
    expect(helmIgnored(rules, "secrets", true)).toBe(true);
    expect(helmIgnored(rules, "secrets", false)).toBe(false);
    expect(helmIgnored(rules, "docs/a.md", false)).toBe(true);
    expect(helmIgnored(rules, "other/docs/a.md", false)).toBe(false);
    expect(helmIgnored(rules, "templates/.hidden", false)).toBe(true);
    expect(helmIgnored(rules, "values.yaml", false)).toBe(false);
  });
});

describe("nfpm entries (#5233)", () => {
  const NFPM = 'name: api\narch: "${CHANT_RELEASE_ARCH}"\nversion: "${CHANT_RELEASE_VERSION}"\ncontents:\n  - src: dist/api\n    dst: /usr/bin/api\n';
  /** A stand-in for nfpm that writes `--target` with what it was given. */
  const fakeNfpm = (ran: Array<{ command: string; env: Record<string, string | undefined> }>) => (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    ran.push({ command, env: { v: o.env.CHANT_RELEASE_VERSION, arch: o.env.CHANT_RELEASE_ARCH, epoch: o.env.SOURCE_DATE_EPOCH } });
    const target = /--target (\S+)/.exec(command)![1]!;
    writeFileSync(join(o.cwd, target), `${command}\n`);
    return 0;
  };

  test("runs nfpm per platform and packager with the version set, and records each package", () => {
    const cwd = member({ "nfpm.yaml": NFPM });
    const ran: Array<{ command: string; env: Record<string, string | undefined> }> = [];
    const decls: ReleaseArtifactDeclaration[] = [{ name: "api", nfpm: { platforms: ["linux/amd64", "linux/arm64"] } }];
    const files = buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", env: { CHANT_NFPM: "/opt/nfpm" }, run: fakeNfpm(ran) });
    expect(files.map((f) => f.path)).toEqual(["dist/api_1.4.0_amd64.deb", "dist/api_1.4.0_amd64.rpm", "dist/api_1.4.0_arm64.deb", "dist/api_1.4.0_arm64.rpm"]);
    expect(ran[0]).toEqual({ command: "/opt/nfpm package --config nfpm.yaml --packager deb --target dist/api_1.4.0_amd64.deb", env: { v: "1.4.0", arch: "amd64", epoch: String(EPOCH) } });
    expect(usesNfpm(decls)).toBe(true);
  });

  test("names the files by fileName, and refuses a config whose version is not the label's, an unknown packager and a platform name with no platforms", () => {
    const cwd = member({ "pkg/nfpm.yaml": NFPM, "bad.yaml": "name: api\nversion: 0.1.0\n" });
    const ran: Array<{ command: string; env: Record<string, string | undefined> }> = [];
    const files = buildReleaseArtifacts({ artifacts: [{ name: "api", nfpm: { config: "pkg/nfpm.yaml", packagers: ["apk"], dir: "out", fileName: "{name}-{label}" } }], cwd, sourceDateEpoch: EPOCH, label: "v2.0.0", env: {}, run: fakeNfpm(ran) });
    expect(files.map((f) => f.path)).toEqual(["out/api-v2.0.0.apk"]);
    expect(ran[0]!.command).toBe("nfpm package --config pkg/nfpm.yaml --packager apk --target out/api-v2.0.0.apk");
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "api", nfpm: { config: "bad.yaml" } }], cwd, sourceDateEpoch: EPOCH, label: "v2.0.0", env: {}, run: fakeNfpm(ran) })).code).toBe("release-artifact-version-mismatch");
    expect(refusal(() => checkReleaseArtifacts([{ name: "api", nfpm: { packagers: ["msi" as never] } }])).code).toBe("release-artifact-invalid");
    expect(refusal(() => checkReleaseArtifacts([{ name: "api", nfpm: { fileName: "{name}_{arch}" } }])).message).toMatch(/names a platform/);
    expect(nfpmConfigVersion("name: x\nversion: '1.0' # pinned\n")).toBe("1.0");
  });

  test("a failed nfpm run, or one that writes nothing, stops the cut", () => {
    const cwd = member({ "nfpm.yaml": NFPM });
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "api", nfpm: {} }], cwd, sourceDateEpoch: EPOCH, label: "v1.0.0", env: {}, run: () => 1 })).code).toBe("release-artifact-build-failed");
    expect(refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "api", nfpm: {} }], cwd, sourceDateEpoch: EPOCH, label: "v1.0.0", env: {}, run: () => 0 })).code).toBe("release-artifact-no-output");
  });
});
