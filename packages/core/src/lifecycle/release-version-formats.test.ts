/**
 * #5156: `release.version.files` stamps the label into manifests other than
 * package.json, in place, so a stamped file differs from the committed one
 * in the version's text alone.
 */

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManifestStampError, resolveVersionFile, stampVersionFile, type ReleaseVersionFile } from "./release-version-formats";
import { checkCheckoutIsRelease } from "./release-publish";
import { checkReleaseVersion, releaseVersionFiles, ReleaseVersionError, stampedChanges, stampReleaseVersion, type ReleaseVersionConfig } from "./release-version";
import { TestRepo } from "../workspace/trust/test-repo";
import { ChantConfigSchema } from "../config";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ManifestStampError).code;
  }
  return undefined;
};

const CARGO = `# The CLI crate.
[package]
name = "acme-cli"   # published as acme-cli
version = "0.0.0"
edition = "2021"
keywords = [
  "cli", # a comment in an array
  "acme",
]

[dependencies]
acme-core = { path = "../core", version = "=0.0.0", features = ["serde"] }
serde = { version = "1.0.200", features = ["derive"] }
outside = { path = "../../../elsewhere", version = "0.0.0" }

[dev-dependencies.acme-test]
path = "../test"
version = "0.0.0"

[target.'cfg(unix)'.dependencies]
acme-unix = { path = "../unix", version = "^0.0.0" }
`;

describe("Cargo", () => {
  test("package.version and the version of each path dependency inside the member change, nothing else", () => {
    const out = stampVersionFile("crates/cli/Cargo.toml", CARGO, "1.4.0");
    expect(out).toBe(
      CARGO.replace(`version = "0.0.0"\nedition`, `version = "1.4.0"\nedition`)
        .replace(`version = "=0.0.0", features`, `version = "=1.4.0", features`)
        .replace(`path = "../test"\nversion = "0.0.0"`, `path = "../test"\nversion = "1.4.0"`)
        .replace(`"^0.0.0"`, `"^1.4.0"`),
    );
    // serde from crates.io and a path outside the member stay as committed.
    expect(out).toContain(`serde = { version = "1.0.200"`);
    expect(out).toContain(`outside = { path = "../../../elsewhere", version = "0.0.0" }`);
  });

  test("a workspace root stamps [workspace.package] and [workspace.dependencies]; a crate that inherits is left", () => {
    const root = `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.0.0"\n\n[workspace.dependencies]\nacme-core = { path = "crates/core", version = "0.0.0" }\n`;
    expect(stampVersionFile("Cargo.toml", root, "2.0.0")).toBe(root.replaceAll("0.0.0", "2.0.0"));
    const member = `[package]\nname = "acme-core"\nversion.workspace = true\n`;
    expect(stampVersionFile("crates/core/Cargo.toml", member, "2.0.0")).toBe(member);
    expect(code(() => stampVersionFile("Cargo.toml", `[package]\nname = "x"\n`, "2.0.0"))).toBe("release-version-no-field");
  });

  test("Cargo.lock: the workspace's crates take the label, registry crates keep theirs", () => {
    const lock = `version = 4\n\n[[package]]\nname = "acme-cli"\nversion = "0.0.0"\ndependencies = [\n "acme-core",\n "serde",\n]\n\n[[package]]\nname = "acme-core"\nversion = "0.0.0"\n\n[[package]]\nname = "serde"\nversion = "0.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;
    const out = stampVersionFile("Cargo.lock", lock, "1.4.0");
    expect(out.match(/1\.4\.0/g)).toHaveLength(2);
    expect(out).toContain(`name = "serde"\nversion = "0.0.0"`);
    const one = stampVersionFile({ path: "Cargo.lock", crates: ["acme-core"] }, lock, "1.4.0");
    expect(one).toContain(`name = "acme-cli"\nversion = "0.0.0"`);
    expect(one).toContain(`name = "acme-core"\nversion = "1.4.0"`);
  });
});

describe("pyproject.toml", () => {
  test("[project] version and [tool.poetry] version", () => {
    const pep = `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "acme"\nversion = "0.0.0"  # stamped at release\ndependencies = ["httpx>=0.0.0"]\n`;
    expect(stampVersionFile("pyproject.toml", pep, "1.4.0rc1")).toBe(pep.replace(`version = "0.0.0"`, `version = "1.4.0rc1"`));
    const poetry = `[tool.poetry]\nname = 'acme'\nversion = '0.0.0'\n`;
    expect(stampVersionFile("pyproject.toml", poetry, "1.4.0")).toBe(poetry.replace("0.0.0", "1.4.0"));
  });

  test("a dynamic version is refused with the way out", () => {
    const dyn = `[project]\nname = "acme"\ndynamic = ["version"]\n`;
    let fix: string | undefined;
    try {
      stampVersionFile("pyproject.toml", dyn, "1.4.0");
    } catch (e) {
      fix = (e as ManifestStampError).fix;
    }
    expect(fix).toMatch(/pattern/);
  });
});

describe("YAML manifests", () => {
  const CHART = `# A chart.\napiVersion: v2\nname: acme\nversion: 0.0.0 # the chart\nappVersion: "0.0.0"\ndependencies:\n  - name: redis\n    version: 18.0.0\n    repository: https://charts.bitnami.com/bitnami\n`;

  test("Chart.yaml: version, and appVersion when asked", () => {
    expect(stampVersionFile("charts/acme/Chart.yaml", CHART, "1.4.0")).toBe(CHART.replace("version: 0.0.0", "version: 1.4.0"));
    expect(stampVersionFile({ path: "charts/acme/Chart.yaml", appVersion: true }, CHART, "1.4.0")).toBe(CHART.replace("version: 0.0.0", "version: 1.4.0").replace(`appVersion: "0.0.0"`, `appVersion: "1.4.0"`));
  });

  test("a krew manifest: spec.version with its v, and the version in each platform's uri", () => {
    const krew = `apiVersion: krew.googlecontainertools.github.com/v1alpha2\nkind: Plugin\nmetadata:\n  name: acme\nspec:\n  version: "v0.1.0"\n  description: |\n    version: 9.9.9 inside a block scalar\n  platforms:\n  - selector:\n      matchLabels:\n        os: linux\n    uri: https://example.com/download/kubectl-acme-v0.1.0/kubectl-acme-v0.1.0.tar.gz\n    sha256: "aa"\n    bin: kubectl-acme\n  - selector:\n      matchLabels:\n        os: darwin\n    uri: https://example.com/download/kubectl-acme-v0.1.0/kubectl-acme-v0.1.0-darwin.tar.gz\n    sha256: "bb"\n`;
    const out = stampVersionFile({ path: "krew/acme.yaml", format: "krew" }, krew, "1.4.0");
    expect(out).toBe(krew.replace(`"v0.1.0"`, `"v1.4.0"`).replaceAll("kubectl-acme-v0.1.0", "kubectl-acme-v1.4.0"));
    expect(out).toContain("version: 9.9.9 inside a block scalar");
    expect(code(() => resolveVersionFile("krew/acme.yaml"))).toBe("release-version-format-unknown");
  });

  test("artifacthub-pkg.yml: version, and a pattern reaches an annotation", () => {
    const hub = `# Artifact Hub metadata.\nversion: 0.1.0\nname: acme\nannotations:\n  headlamp/plugin/archive-url: "https://example.com/acme-v0.1.0/acme-0.1.0.tar.gz"\n`;
    expect(stampVersionFile("artifacthub-pkg.yml", hub, "1.4.0")).toBe(hub.replace("version: 0.1.0", "version: 1.4.0"));
    expect(stampVersionFile({ path: "artifacthub-pkg.yml", pattern: "acme-v([0-9.]+)/acme-([0-9.]+)\\.tar" }, hub, "1.4.0")).toBe(hub.replace("acme-v0.1.0/acme-0.1.0", "acme-v1.4.0/acme-1.4.0"));
  });
});

describe("an MCP server.json", () => {
  test("version and each package's version, formatting kept", () => {
    const server = `{\n  "name": "io.github.acme/acme",\n  "version": "0.0.0",\n  "packages": [\n    { "registryType": "npm", "identifier": "@acme/mcp", "version": "0.0.0" },\n    { "registryType": "oci", "identifier": "ghcr.io/acme/mcp:latest" }\n  ],\n  "_meta": { "x": { "version": "keep" } }\n}\n`;
    expect(stampVersionFile("server.json", server, "1.4.0")).toBe(server.replaceAll(`"0.0.0"`, `"1.4.0"`));
  });
});

describe("fields and patterns", () => {
  test("a field in JSON, YAML or TOML, with a prefix", () => {
    expect(stampVersionFile({ path: "meta.json", field: "release.tag", prefix: "v" }, `{"release": {"tag": "v0.0.0"}}`, "1.4.0")).toBe(`{"release": {"tag": "v1.4.0"}}`);
    expect(stampVersionFile({ path: "a.yaml", field: "items[].version" }, `items:\n- version: '0'\n- version: '0'\n`, "1.4.0")).toBe(`items:\n- version: '1.4.0'\n- version: '1.4.0'\n`);
    expect(stampVersionFile({ path: "a.toml", field: "tool.acme.version" }, `[tool.acme]\nversion = "0"\n`, "1.4.0")).toBe(`[tool.acme]\nversion = "1.4.0"\n`);
    expect(code(() => stampVersionFile({ path: "a.yaml", field: "nope" }, `version: 1\n`, "1.4.0"))).toBe("release-version-no-field");
    expect(code(() => stampVersionFile({ path: "a.json", field: "version" }, `{"version": 1}`, "1.4.0"))).toBe("release-version-invalid");
    expect(code(() => resolveVersionFile({ path: "VERSION", field: "version" }))).toBe("release-version-format-unknown");
  });

  test("a pattern: each capture group of every match", () => {
    expect(stampVersionFile({ path: "version.go", pattern: 'Version = "v([^"]+)"' }, `package version\n\nconst Version = "v0.0.0"\n`, "1.4.0")).toBe(`package version\n\nconst Version = "v1.4.0"\n`);
    expect(stampVersionFile({ path: "VERSION", pattern: "^(.+)$", prefix: "v" }, "v0.0.0\n", "1.4.0")).toBe("v1.4.0\n");
    expect(code(() => resolveVersionFile({ path: "VERSION", pattern: "0\\.0\\.0" }))).toBe("release-version-invalid");
    expect(code(() => stampVersionFile({ path: "VERSION", pattern: "x(y)" }, "abc\n", "1.4.0"))).toBe("release-version-no-field");
  });
});

/** A Rust and Helm project with no package.json, committed and green. */
function project(label: string): { r: TestRepo; head: string } {
  const r = new TestRepo(label);
  repos.push(r);
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("Cargo.toml", CARGO.replaceAll("../", "crates/"));
  r.write("charts/acme/Chart.yaml", `apiVersion: v2\nname: acme\nversion: 0.0.0\n`);
  r.write("VERSION", "0.0.0\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return { r, head };
}

const FILES: ReleaseVersionConfig = { files: ["Cargo.toml", "charts/acme/Chart.yaml", { path: "VERSION", pattern: "^(.+)$" }] };

describe("release.version.files at the cut and the publish (#5156)", () => {
  test("files alone, with no packages, stamp and restore byte for byte", () => {
    const { r } = project("release-version-files-stamp");
    expect(releaseVersionFiles(r.dir, FILES)).toEqual(["Cargo.toml", "charts/acme/Chart.yaml", "VERSION"]);
    const s = stampReleaseVersion({ cwd: r.dir, config: FILES, label: "1.4.0" });
    expect(readFileSync(join(r.dir, "charts/acme/Chart.yaml"), "utf-8")).toContain("version: 1.4.0");
    expect(readFileSync(join(r.dir, "VERSION"), "utf-8")).toBe("1.4.0\n");
    s.restore();
    expect(r.git(["status", "--porcelain"])).toBe("");
  });

  test("the publish takes the stamped files as the commit's, and only with this release's label", () => {
    const { r, head } = project("release-version-files-publish");
    stampReleaseVersion({ cwd: r.dir, config: FILES, label: "1.4.0" });
    expect(checkCheckoutIsRelease(r.dir, head, "1.4.0", { version: FILES, label: "1.4.0" })).toBeNull();
    expect(checkCheckoutIsRelease(r.dir, head, "1.4.1", { version: FILES, label: "1.4.1" })?.code).toBe("release-worktree-dirty");
    const status = r.git(["status", "--porcelain"]);
    expect(stampedChanges({ cwd: r.dir, top: r.dir, commit: head, config: FILES, label: "1.4.0", status }).size).toBe(3);
    // Another edit in a stamped file is a change.
    r.write("VERSION", "1.4.0\nextra\n");
    expect(checkCheckoutIsRelease(r.dir, head, "1.4.0", { version: FILES, label: "1.4.0" })?.code).toBe("release-worktree-dirty");
  });

  test("a missing file, an unknown format and a file named twice are refused before anything is written", () => {
    const { r } = project("release-version-files-refuse");
    const refuse = (config: ReleaseVersionConfig): string | undefined => {
      try {
        stampReleaseVersion({ cwd: r.dir, config, label: "1.4.0" });
      } catch (e) {
        return (e as ReleaseVersionError).code;
      }
      return undefined;
    };
    expect(refuse({ files: ["Cargo.toml", "charts/nope/Chart.yaml"] })).toBe("release-version-no-file");
    expect(refuse({ files: ["VERSION"] })).toBe("release-version-format-unknown");
    expect(refuse({ files: ["Cargo.toml", "./Cargo.toml"] })).toBe("release-version-invalid");
    expect(refuse({ files: ["../Cargo.toml"] })).toBe("release-version-invalid");
    expect(refuse({ files: [{ path: "VERSION", pattern: "nomatch(x)" }] })).toBe("release-version-no-field");
    expect(r.git(["status", "--porcelain"])).toBe("");
    expect(() => checkReleaseVersion({})).toThrow(/no package directory and no file/);
  });

  test("chant.config.ts takes files, with or without packages", () => {
    const ok = (version: unknown): boolean => ChantConfigSchema.safeParse({ release: { version } }).success;
    const files: ReleaseVersionFile[] = ["Cargo.toml", { path: "krew/acme.yaml", format: "krew" }, { path: "Chart.yaml", appVersion: true }, { path: "a.json", field: "version" }, { path: "VERSION", pattern: "(.+)", prefix: "v" }];
    expect(ok({ files })).toBe(true);
    expect(ok({ packages: ["."], files: ["server.json"] })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ files: [{ path: "x", format: "gradle" }] })).toBe(false);
    expect(ok({ files: [{ path: "x", field: "v", pattern: "(.)" }] })).toBe(false);
  });
});
