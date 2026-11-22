import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseYAML } from "../yaml";
import { loadChantConfig } from "../config";
import type { CommandContext } from "../cli/registry";
import { runReleaseInit } from "../cli/handlers/release-init";
import {
  dependencyOrder,
  detectProject,
  expandWorkspacePattern,
  insertReleaseBlock,
  newConfigSource,
  planRelease,
  planTrain,
  readTagHistory,
  trainFit,
  ReleaseInitError,
  tagTemplateOf,
  SUPPLY_CHAIN_NOTE,
  type InitPackage,
  type ProjectFacts,
} from "./release-init";

function repo(files: Record<string, string>, opts: { origin?: string; tags?: string[] } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5160-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  if (opts.origin) git("remote", "add", "origin", opts.origin);
  for (const t of opts.tags ?? []) git("tag", t);
  return root;
}

const PLAN = { chantVersion: "0.124.101" };

describe("the tag history (#5160)", () => {
  test("version tags are grouped by prefix, the largest group first, and chant's own tags are left out", () => {
    const h = readTagHistory(["v1.0.0", "v1.10.0", "v1.2.0", "v1.10.0-rc.1", "cli-v0.1.0", "ci/green/abc", "nightly", "@acme/core@1.0.0"]);
    expect(h.prefix).toBe("v");
    expect(h.count).toBe(4);
    expect(h.newest).toBe("v1.10.0");
    expect(h.others).toEqual([
      { prefix: "@acme/core@", count: 1 },
      { prefix: "cli-v", count: 1 },
    ]);
    expect(readTagHistory([])).toEqual({ prefix: null, count: 0, newest: null, others: [] });
  });

  test("the template follows the history, and a project with none gets v{version}", () => {
    const facts = (tags: string[], extra: Partial<ProjectFacts> = {}) => ({ tags: readTagHistory(tags), go: null, path: null, ...extra });
    expect(tagTemplateOf(facts(["v1.0.0", "v1.1.0"]))).toMatchObject({ template: "v{version}", legacy: ["v"] });
    expect(tagTemplateOf(facts(["cli-v1.0.0"]))).toMatchObject({ template: "cli-v{version}", legacy: ["cli-v"] });
    expect(tagTemplateOf(facts(["1.0.0", "1.1.0"]))).toMatchObject({ template: "{version}", legacy: [] });
    expect(tagTemplateOf(facts([]))).toMatchObject({ template: "v{version}", legacy: [] });
    // A Go module in a subdirectory is tagged <path>/v<version>.
    expect(tagTemplateOf(facts([], { go: { module: "example.com/acme/tools" }, path: "tools" }))).toMatchObject({ template: "{path}/v{version}" });
    // A prefix a template can't hold is read by nothing and left.
    expect(tagTemplateOf(facts(["@acme/core@1.0.0"]))).toMatchObject({ template: "v{version}", legacy: [] });
    // One package's tags don't name a release of several, so they are only read.
    expect(tagTemplateOf(facts(["cli-v0.1.0", "cli-v0.2.0"]), 2)).toMatchObject({ template: "v{version}", legacy: ["cli-v"] });
  });
});

describe("detecting the project (#5160)", () => {
  test("npm workspaces: the public packages in dependency order, private ones left out", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*", "!packages/skip"] }),
      "package-lock.json": "{}",
      "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
      "packages/cli/package.json": JSON.stringify({ name: "@acme/cli", publishConfig: { access: "public" }, dependencies: { "@acme/core": "^1.0.0" } }),
      "packages/internal/package.json": JSON.stringify({ name: "@acme/internal", private: true }),
      "packages/skip/package.json": JSON.stringify({ name: "@acme/skip" }),
    }, { origin: "git@github.com:acme/mono.git" });
    const facts = detectProject(root);
    expect(facts.node!.workspaces!.map((p) => p.dir)).toEqual(["packages/cli", "packages/core", "packages/internal"]);
    expect(facts.origin).toEqual({ kind: "github", host: "github.com", repo: "acme/mono" });
    const plan = planRelease(facts, PLAN);
    expect(plan.release.publish).toEqual([{ type: "npm", packages: ["packages/core", "packages/cli"], access: "public" }]);
    expect(plan.release.version).toEqual({ packages: ["packages/core", "packages/cli"], ranges: "exact" });
    expect(plan.release.green).toBe("forge-checks");
    expect(plan.release.workflow).toEqual({ trigger: "dispatch", chant: "npx --yes @intentius/chant@0.124.101" });
    expect(plan.notes.join("\n")).toContain("@acme/internal");
    expect(plan.notes.join("\n")).toContain("No CI workflow runs");
    expect(plan.registry.join("\n")).toContain("the workflow file chant-release.yml");
  });

  test("pnpm workspaces and yarn: their own install, and the build with the same tool", () => {
    const pnpm = repo({
      "package.json": JSON.stringify({ name: "mono", private: true, scripts: { build: "tsc -b" }, devDependencies: { "@intentius/chant": "^0.124.0" } }),
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
      "pnpm-lock.yaml": "",
      "libs/a/package.json": JSON.stringify({ name: "a" }),
    });
    const facts = detectProject(pnpm);
    expect(facts.node!.manager).toBe("pnpm");
    expect(facts.node!.workspaces!.map((p) => p.name)).toEqual(["a"]);
    expect(planRelease(facts, PLAN).release.workflow).toEqual({ trigger: "dispatch", install: "corepack enable && pnpm install --frozen-lockfile", build: "pnpm run build" });
    const yarn = repo({ "package.json": JSON.stringify({ name: "solo" }), "yarn.lock": "", ".yarnrc.yml": "" });
    expect((planRelease(detectProject(yarn), PLAN).release.workflow as { install: string }).install).toBe("corepack enable && yarn install --immutable");
  });

  test("a Go module with goreleaser: the goreleaser artifact entry, a forge release of its files, and the snapshot template to add", () => {
    const root = repo({
      ".github/workflows/ci.yml": "on: push\n",
      "go.mod": "module github.com/acme/tool\n\ngo 1.24\n",
      ".goreleaser.yaml": "version: 2\nbuilds:\n  - goos: [linux]\n",
      ".gitignore": "dist/\n",
    }, { origin: "https://github.com/acme/tool.git", tags: ["v0.1.0"] });
    const facts = detectProject(root);
    expect(facts.goreleaser).toEqual({ file: ".goreleaser.yaml", labelTemplate: false, snapshot: false, images: false, changelog: null });
    const plan = planRelease(facts, PLAN);
    expect(plan.release.tag).toBe("v{version}");
    expect(plan.release.artifacts).toEqual([{ name: "goreleaser", goreleaser: {} }]);
    expect(plan.release.publish).toEqual([{ type: "forge", forge: "github", repo: "acme/tool", assets: ["artifact:goreleaser"], notes: { generate: "forge" } }]);
    expect(plan.goreleaserPatch).toEqual({ file: ".goreleaser.yaml", append: 'snapshot:\n  version_template: "{{ .Env.CHANT_RELEASE_LABEL }}"\n', manual: null });
    expect(plan.notes.join("\n")).not.toContain("No CI workflow");
    // A config with a snapshot section of its own is told, not edited.
    writeFileSync(join(root, ".goreleaser.yaml"), "version: 2\nsnapshot:\n  version_template: '{{ .Version }}-next'\n");
    expect(planRelease(detectProject(root), PLAN).goreleaserPatch).toMatchObject({ append: null, manual: expect.stringContaining("CHANT_RELEASE_LABEL") });
  });

  test("a goreleaser changelog that filters commit types becomes notes from commits with exclude (#5270)", () => {
    const changelog = 'changelog:\n  use: github\n  sort: asc\n  filters:\n    exclude:\n      - "^docs:"\n      - "^test:"\n      - "^chore(\\\\(.*\\\\))?:"\n';
    const root = repo({
      ".github/workflows/ci.yml": "on: push\n",
      "go.mod": "module github.com/acme/tool\n\ngo 1.24\n",
      ".goreleaser.yaml": `version: 2\n${changelog}`,
      ".gitignore": "dist/\n",
    }, { origin: "https://github.com/acme/tool.git", tags: ["v0.1.0"] });
    const facts = detectProject(root);
    expect(facts.goreleaser?.changelog).toEqual({ exclude: ["docs", "test", "chore"] });
    const plan = planRelease(facts, PLAN);
    expect(plan.release.publish).toEqual([{ type: "forge", forge: "github", repo: "acme/tool", assets: ["artifact:goreleaser"], notes: { generate: "commits", exclude: ["docs", "test", "chore"] } }]);
    expect(plan.reasons.join("\n")).toContain("except docs, test, chore");
    // A filter that names no commit type keeps the forge's notes, and says so.
    writeFileSync(join(root, ".goreleaser.yaml"), 'version: 2\nchangelog:\n  filters:\n    exclude:\n      - "(?i)typo"\n');
    const other = planRelease(detectProject(root), PLAN);
    expect(other.release.publish).toMatchObject([{ notes: { generate: "forge" } }]);
    expect(other.notes.join("\n")).toContain('"(?i)typo" name no commit type');
  });

  test("a goreleaser config that builds its image with dockers: release.images and an oci target carry it (#5269)", () => {
    const goreleaser = [
      "version: 2",
      "dockers:",
      "  - image_templates: ['ghcr.io/acme/tool:{{ .Version }}-amd64']",
      "    dockerfile: Dockerfile",
      "    goarch: amd64",
      "    build_flag_templates: ['--build-arg=VERSION={{ .Version }}']",
      "  - image_templates: ['ghcr.io/acme/tool:{{ .Version }}-arm64']",
      "    dockerfile: Dockerfile",
      "    goarch: arm64",
      "    build_flag_templates: ['--build-arg=VERSION={{ .Version }}']",
      "docker_manifests:",
      "  - name_template: 'ghcr.io/acme/tool:{{ .Version }}'",
      "  - name_template: 'ghcr.io/acme/tool:latest'",
      "",
    ].join("\n");
    const root = repo({
      ".github/workflows/ci.yml": "on: push\n",
      "go.mod": "module github.com/acme/tool\n\ngo 1.24\n",
      ".goreleaser.yaml": goreleaser,
      Dockerfile: "FROM golang:1.24 AS build\nRUN go build -o /tool .\nFROM scratch\nCOPY --from=build /tool /tool\n",
      ".gitignore": "dist/\n",
    }, { origin: "https://github.com/acme/tool.git", tags: ["v0.1.0"] });
    const plan = planRelease(detectProject(root), PLAN);
    expect(plan.release.images).toEqual([{ name: "tool", dockerfile: "Dockerfile", platforms: ["linux/amd64", "linux/arm64"], archive: "build/images/tool.tar", args: { VERSION: "{version}" } }]);
    expect(plan.release.publish).toContainEqual({ type: "oci", image: "build/images/tool.tar", repository: "ghcr.io/acme/tool", tags: ["{version}", "latest"], platformTags: ["{version}-{arch}"] });
    const notes = plan.notes.join("\n");
    expect(notes).toContain("Remove dockers and docker_manifests from .goreleaser.yaml");
    expect(notes).toContain("build/ is not in .gitignore");
    expect(notes).not.toContain("Not carried");
    // A one-stage Dockerfile that copies goreleaser's binary is named.
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY tool /tool\n");
    expect(planRelease(detectProject(root), PLAN).notes.join("\n")).toContain("give it a build stage of its own");
  });

  test("Helm charts and an nfpm config: helm and nfpm artifact entries, a helm target on the forge's registry, and the packages on the forge release (#5233)", () => {
    const root = repo({
      ".github/workflows/ci.yml": "on: push\n",
      "go.mod": "module github.com/acme/tool\n\ngo 1.24\n",
      "deploy/charts/tool/Chart.yaml": "apiVersion: v2\nname: tool\nversion: 0.1.0\n",
      "deploy/charts/tool/charts/sub/Chart.yaml": "apiVersion: v2\nname: sub\nversion: 0.1.0\n",
      "nfpm.yaml": "name: tool\nversion: 1.0.0\n",
      ".gitignore": "dist/\n",
    }, { origin: "https://github.com/acme/tool.git" });
    const facts = detectProject(root);
    expect(facts.charts).toEqual([{ dir: "deploy/charts/tool", name: "tool" }]);
    expect(facts.nfpm).toEqual({ file: "nfpm.yaml", version: false });
    const plan = planRelease(facts, PLAN);
    expect(plan.release.artifacts).toEqual([{ name: "chart", helm: { chart: "deploy/charts/tool" } }, { name: "packages", nfpm: {} }]);
    expect(plan.release.publish).toEqual([
      { type: "helm", charts: ["artifact:chart"], oci: { repository: "ghcr.io/acme/tool/charts" } },
      { type: "forge", forge: "github", repo: "acme/tool", assets: ["artifact:packages"], notes: { generate: "forge" } },
    ]);
    expect(plan.notes.join("\n")).toContain('version: "${CHANT_RELEASE_VERSION}"');
  });

  test("Dockerfiles become release.images and an oci target on the forge's registry; chant ci's green tags pick the chant gate", () => {
    const root = repo({ Dockerfile: "FROM scratch\n", "worker/Dockerfile": "FROM scratch\n" }, { origin: "https://gitlab.com/acme/Svc.git", tags: ["ci/green/0000000000000000000000000000000000000000"] });
    const plan = planRelease(detectProject(root), PLAN);
    expect(plan.release.images).toEqual([
      { name: "svc", dockerfile: "Dockerfile" },
      { name: "worker", dockerfile: "worker/Dockerfile", context: "worker" },
    ]);
    expect(plan.release.publish).toEqual([
      { type: "oci", image: "dist/images/svc.tar", repository: "registry.gitlab.com/acme/svc/svc" },
      { type: "oci", image: "dist/images/worker.tar", repository: "registry.gitlab.com/acme/svc/worker" },
    ]);
    expect(plan.release.green).toBe("chant");
    expect(plan.workflowFile).toBe(".gitlab/chant-release.yml");
    expect(plan.notes.join("\n")).toContain("dist/ is not in .gitignore");
  });

  test("a VS Code extension publishes to both marketplaces; a Python and a Rust package beside it get their targets", () => {
    const root = repo({ "package.json": JSON.stringify({ name: "acme-vscode", publisher: "acme", engines: { vscode: "^1.90.0" } }), "pyproject.toml": '[project]\nname = "acme"\n', "Cargo.toml": '[package]\nname = "acme-rs"\n' }, { origin: "https://github.com/acme/ext" });
    const plan = planRelease(detectProject(root), PLAN);
    expect(plan.release.publish).toEqual([
      { type: "marketplace", marketplace: "vscode", vsix: "dist/acme-vscode.vsix" },
      { type: "marketplace", marketplace: "openvsx", vsix: "dist/acme-vscode.vsix", auth: "trusted-publishing" },
      { type: "pypi", files: ["artifact:python"], auth: "trusted-publishing" },
      { type: "cargo" },
    ]);
    expect((plan.release.workflow as { env: Record<string, string> }).env).toEqual({ VSCE_PAT: "${{ secrets.VSCE_PAT }}" });
    expect(plan.registry.join("\n")).toContain("open-vsx.org/user-settings/trusted-publishers");
  });

  test("pyproject.toml gets a pypi target with a build artifact and a version file (#5202)", () => {
    const root = repo({ "pyproject.toml": '[project]\nname = "acme-py"\nversion = "0.3.0"\n' }, { origin: "https://github.com/acme/py" });
    const plan = planRelease(detectProject(root), PLAN);
    expect(plan.release.artifacts).toEqual([{ name: "python", build: "python -m pip install build && python -m build", outputs: ["dist/*"] }]);
    expect(plan.release.publish).toEqual([{ type: "pypi", files: ["artifact:python"], auth: "trusted-publishing" }]);
    expect(plan.release.version).toEqual({ files: ["pyproject.toml"] });
    expect(plan.registry.join("\n")).toContain("trusted publisher");
    expect(plan.registry.join("\n")).toContain("chant-release.yml");
    expect(plan.notes.join("\n")).toContain("dist/ is not in .gitignore");
    // GitLab names the pipeline file; Forgejo has no trusted publisher, so it takes a token.
    const gl = planRelease(detectProject(repo({ "pyproject.toml": '[project]\nname = "acme-py"\n', ".gitlab-ci.yml": "x: 1\n" })), PLAN);
    expect(gl.registry.join("\n")).toContain(".gitlab-ci.yml");
    const fj = planRelease(detectProject(repo({ "pyproject.toml": '[project]\nname = "acme-py"\n', ".forgejo/workflows/ci.yml": "on: push\n" })), PLAN);
    expect(fj.release.publish).toEqual([{ type: "pypi", files: ["artifact:python"], auth: "token" }]);
    expect((fj.release.workflow as { env: Record<string, string> }).env).toEqual({ PYPI_TOKEN: "${{ secrets.PYPI_TOKEN }}" });
    // A dynamic version is left to the build, and a pyproject with no project name is not published.
    expect(gl.release.version).toBeUndefined();
    expect(gl.notes.join("\n")).toContain("no static version");
    const bare = planRelease(detectProject(repo({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" })), PLAN);
    expect(bare.release.publish).toBeUndefined();
    expect(bare.notes.join("\n")).toContain("not published to PyPI");
  });

  test("Cargo.toml gets a cargo target and a version file; publish = false gets neither (#5202)", () => {
    const plan = planRelease(detectProject(repo({ "Cargo.toml": '[package]\nname = "acme-rs"\nversion = "0.2.0"\n' }, { origin: "https://github.com/acme/rs" })), PLAN);
    expect(plan.release.publish).toEqual([{ type: "cargo" }]);
    expect(plan.release.version).toEqual({ files: ["Cargo.toml"] });
    expect(plan.registry.join("\n")).toContain("CARGO_REGISTRY_TOKEN");
    expect(plan.registry.join("\n")).toContain("trusted publisher");
    const ws = planRelease(detectProject(repo({ "Cargo.toml": '[workspace]\nmembers = ["a"]\n[workspace.package]\nversion = "1.0.0"\n' })), PLAN);
    expect(ws.release.publish).toEqual([{ type: "cargo" }]);
    expect(ws.release.version).toEqual({ files: ["Cargo.toml"] });
    const priv = planRelease(detectProject(repo({ "Cargo.toml": '[package]\nname = "tool"\nversion = "0.1.0"\npublish = false\n' })), PLAN);
    expect(priv.release.publish).toBeUndefined();
    expect(priv.notes.join("\n")).toContain("publish = false");
  });

  test("pom.xml, a .csproj and a .gemspec get built artifacts and maven, nuget and rubygems targets (#5232)", () => {
    const files = {
      "pom.xml": "<project><parent><groupId>dev.parent</groupId></parent><artifactId>kit</artifactId><version>1.0.0</version><dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId></dependency></dependencies></project>",
      "Kit.csproj": "<Project><PropertyGroup><PackageId>Acme.Kit</PackageId></PropertyGroup></Project>",
      "Tests.csproj": "<Project><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>",
      "acme.gemspec": 'Gem::Specification.new do |spec|\n  spec.name = "acme"\nend\n',
    };
    const gh = planRelease(detectProject(repo(files, { origin: "https://github.com/acme/kit" })), PLAN);
    expect(gh.release.publish).toEqual([
      { type: "maven", bundle: "artifact:maven" },
      { type: "nuget", packages: ["artifact:nuget"], auth: "trusted-publishing" },
      { type: "rubygems", gems: ["artifact:gem"], auth: "trusted-publishing" },
    ]);
    const artifacts = gh.release.artifacts as Array<{ name: string; build: string; outputs: string[] }>;
    expect(artifacts.map((a) => a.name)).toEqual(["maven", "nuget", "gem"]);
    expect(artifacts[1]!.build).toBe('dotnet pack Kit.csproj -c Release -o dist/nuget -p:Version="$CHANT_RELEASE_LABEL"');
    expect(artifacts[2]!.outputs).toEqual(["dist/gem/*.gem"]);
    expect((gh.release.workflow as { env: Record<string, string> }).env).toEqual({ MAVEN_CENTRAL_USERNAME: "${{ secrets.MAVEN_CENTRAL_USERNAME }}", MAVEN_CENTRAL_PASSWORD: "${{ secrets.MAVEN_CENTRAL_PASSWORD }}", NUGET_USER: "${{ secrets.NUGET_USER }}" });
    const steps = gh.registry.join("\n");
    expect(steps).toContain("Maven Central dev.parent:kit: verify the namespace dev.parent");
    expect(steps).toContain("nuget.org Acme.Kit: add a trusted publishing policy");
    expect(steps).toContain("RubyGems.org acme: add a trusted publisher");
    const fj = planRelease(detectProject(repo({ "acme.gemspec": "spec.name = 'acme'\n", "Kit.csproj": "<Project/>" }, { origin: "https://codeberg.org/acme/kit" })), PLAN);
    expect(fj.release.publish).toEqual([
      { type: "nuget", packages: ["artifact:nuget"], auth: "token" },
      { type: "rubygems", gems: ["artifact:gem"], auth: "token" },
    ]);
    expect((fj.release.workflow as { env: Record<string, string> }).env).toEqual({ NUGET_API_KEY: "${{ secrets.NUGET_API_KEY }}", GEM_HOST_API_KEY: "${{ secrets.GEM_HOST_API_KEY }}" });
  });

  test("a package.json and a pyproject.toml share release.version (#5202)", () => {
    const root = repo({ "package.json": JSON.stringify({ name: "acme-js" }), "pyproject.toml": '[project]\nname = "acme-py"\nversion = "0.1.0"\n' });
    const plan = planRelease(detectProject(root), PLAN);
    expect(plan.release.version).toEqual({ packages: ["."], files: ["pyproject.toml"] });
  });

  test("workspace patterns expand ** and plain directories", () => {
    const root = repo({ "a/b/c/package.json": "{}", "x/package.json": "{}" });
    expect(expandWorkspacePattern(root, "a/**")).toEqual(["a", "a/b", "a/b/c"]);
    expect(expandWorkspacePattern(root, "./x")).toEqual(["x"]);
    const pkg = (dir: string, name: string, deps: string[] = []): InitPackage => ({ dir, name, private: false, access: null, vscode: false, publisher: null, deps, scripts: [] });
    expect(dependencyOrder([pkg("a", "a", ["c"]), pkg("b", "b"), pkg("c", "c", ["b"])]).map((p) => p.dir)).toEqual(["b", "c", "a"]);
  });
});

describe("writing the release block (#5160)", () => {
  const release = { tag: "v{version}", publish: [{ type: "npm", packages: ["."] }] };

  test("a new config is the block alone, and loads as chant reads it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5160-new-")));
    writeFileSync(join(root, "chant.config.ts"), newConfigSource(release));
    expect((await loadChantConfig(root)).config.release).toEqual(release);
  });

  test("added to an existing default export, a defineConfig call, or an exported const", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5160-edit-")));
    for (const src of [
      'export default {\n  lexicons: ["aws"],\n  sourceDir: "src" // the sources\n};\n',
      "export default {};\n",
      'const defineConfig = <T,>(c: T): T => c;\nexport default defineConfig({ lexicons: ["aws"] });\n',
      'const config = {\n    lexicons: ["aws"],\n};\nexport default config;\n',
      '// "export default" in a comment\nconst x = "}";\nexport default ({\n  lexicons: ["aws"],\n});\n',
    ]) {
      const out = insertReleaseBlock(src, release, false);
      writeFileSync(join(root, "chant.config.ts"), out);
      expect((await loadChantConfig(root)).config.release, out).toEqual(release);
    }
    expect(insertReleaseBlock('const config = {\n    lexicons: ["aws"],\n};\nexport default config;\n', release, false)).toContain('\n    release: {\n        tag: "v{version}",');
  });

  test("an existing release block is refused without force and replaced with it", async () => {
    const src = 'export default {\n  release: { autoRecord: false, workflow: { after: ["echo }"] } },\n  lexicons: ["aws"],\n};\n';
    expect(() => insertReleaseBlock(src, release, false)).toThrow(expect.objectContaining({ code: "release-init-release-exists" }));
    const out = insertReleaseBlock(src, release, true);
    expect(out).not.toContain("autoRecord");
    expect(out).toContain('lexicons: ["aws"]');
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5160-force-")));
    writeFileSync(join(root, "chant.config.ts"), out);
    expect((await loadChantConfig(root)).config.release).toEqual(release);
  });

  test("a config whose default export is not an object literal is refused", () => {
    expect(() => insertReleaseBlock("export default makeConfig();\n", release, false)).toThrow(ReleaseInitError);
    expect(() => insertReleaseBlock("module.exports = {};\n", release, false)).toThrow(expect.objectContaining({ code: "release-init-config-unreadable" }));
  });
});

describe("chant release init (#5160)", () => {
  async function run(root: string, args: Record<string, unknown>): Promise<{ code: number; out: string }> {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      return { code: await runReleaseInit({ args } as unknown as CommandContext), out: lines.join("\n") };
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  }

  test("a dry run writes nothing; --yes writes the config, the goreleaser template and the workflow", async () => {
    const root = repo({ "go.mod": "module github.com/acme/tool\n\ngo 1.24\n", ".goreleaser.yaml": "version: 2\n", ".github/workflows/ci.yml": "on: push\n" }, { origin: "https://github.com/acme/tool.git" });
    const dry = await run(root, {});
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Dry run");
    expect(existsSync(join(root, "chant.config.ts"))).toBe(false);
    expect(readFileSync(join(root, ".goreleaser.yaml"), "utf-8")).toBe("version: 2\n");

    const wrote = await run(root, { yes: true });
    expect(wrote.code).toBe(0);
    expect((await loadChantConfig(root)).config.release).toMatchObject({ tag: "v{version}", green: "forge-checks", workflow: { trigger: "dispatch" }, artifacts: [{ name: "goreleaser", goreleaser: {} }] });
    expect(readFileSync(join(root, ".goreleaser.yaml"), "utf-8")).toContain("{{ .Env.CHANT_RELEASE_LABEL }}");
    const workflowText = readFileSync(join(root, ".github/workflows/chant-release.yml"), "utf-8");
    const doc = parseYAML(workflowText) as { on: Record<string, unknown> };
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    // The cut job installs the pinned goreleaser the artifact entry runs.
    expect(workflowText).toContain("CHANT_GORELEASER");
    expect(wrote.out).toContain("chant release doctor\n  gh workflow run chant-release.yml -f label=0.1.0");

    // Run again: the release block is there, so it is refused until --force.
    expect((await run(root, { yes: true })).out).toContain("release-init-release-exists");
    expect((await run(root, { yes: true, force: true })).code).toBe(0);
  });

  test("a release workflow chant did not write is left alone without --force", async () => {
    const root = repo({ "package.json": JSON.stringify({ name: "acme" }), ".github/workflows/chant-release.yml": "name: mine\n" });
    const r = await run(root, { yes: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release-init-workflow-exists");
    expect(existsSync(join(root, "chant.config.ts"))).toBe(false);
  });

  test("--json prints the plan", async () => {
    const root = repo({ "package.json": JSON.stringify({ name: "acme" }), "package-lock.json": "{}" }, { tags: ["v2.0.0"] });
    const r = await run(root, { json: true });
    const doc = JSON.parse(r.out) as { dryRun: boolean; release: { tag: string; legacyTags: string[] }; next: string[] };
    expect(doc.dryRun).toBe(true);
    expect(doc.release.tag).toBe("v{version}");
    expect(doc.release.legacyTags).toEqual(["v"]);
    // #5200: release next reads v2.0.0 as the previous release, so the first release takes auto.
    expect(doc.next.at(-2)).toContain("-f label=auto  # the label from the commits since v2.0.0");
    expect(doc.next.at(-1)).toContain("-f label=auto");

    // Tags no release.tag or legacyTags matches: the first label is a patch after the newest.
    const other = repo({ "package.json": JSON.stringify({ name: "acme" }), "package-lock.json": "{}" }, { tags: ["acme@1.4.0"] });
    const plain = JSON.parse((await run(other, { json: true })).out) as { next: string[] };
    expect(plain.next.at(-2)).toMatch(/-f label=1\.4\.1$/);
  });
});

describe("a workspace released as a train (#5154)", () => {
  const mono = (extra: Record<string, string> = {}, opts: { origin?: string; tags?: string[] } = {}) =>
    repo({
      "package.json": JSON.stringify({ name: "acme-mono", private: true, workspaces: ["packages/*"] }),
      "package-lock.json": "{}",
      ".github/workflows/ci.yml": "on: push\n",
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", version: "0.0.0", files: ["dist"] }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "0.0.0", dependencies: { "@acme/core": "*" } }),
      "packages/internal/package.json": JSON.stringify({ name: "@acme/internal", private: true }),
      ...extra,
    }, { origin: "git@github.com:acme/mono.git", ...opts });

  test("a member per publishable package, in dependency order, and the train at the root", () => {
    const facts = detectProject(mono());
    expect(trainFit(facts)).toEqual({ train: true });
    const plan = planTrain(facts, PLAN);
    expect(plan.workspaceName).toBe("mono");
    expect(plan.members.map((m) => [m.name, m.dir, m.package])).toEqual([
      ["core", "packages/core", "@acme/core"],
      ["web", "packages/web", "@acme/web"],
    ]);
    expect(plan.members[0]!.release).toEqual({ tag: "{member}/v{version}", green: "forge-checks", version: { packages: ["."] }, publish: [{ type: "npm", packages: ["."], access: "public" }] });
    // web depends on core, so its range names the version the train gives core.
    expect(plan.members[1]!.release.version).toEqual({ packages: ["."], ranges: "train" });
    expect(plan.release).toEqual({ train: { env: "npm" }, green: "forge-checks", workflow: { trigger: "dispatch", chant: "npx --yes @intentius/chant@0.124.101" } });
    expect(plan.notes.join("\n")).toContain("@acme/internal");
    // core lists its files; web packs everything, chant.config.ts too.
    expect(plan.notes.join("\n")).toMatch(/chant\.config\.ts with it .*: @acme\/web has neither/);
    expect(plan.registry).toHaveLength(2);
    expect(plan.registry[0]).toContain("naming acme/mono and the workflow file chant-release.yml");
    expect(plan.registry[0]).toContain("publish its first version by hand from packages/core");
  });

  test("shared tags make the first train together; a package's own tags stay its own", () => {
    const facts = detectProject(mono({}, { tags: ["v1.0.0", "v1.1.0", "web-v0.3.0", "@acme/core@1.2.0"] }));
    const plan = planTrain(facts, PLAN);
    expect(plan.release.train).toEqual({ env: "npm", first: "together" });
    expect(plan.release.legacyTags).toEqual(["v"]);
    const [core, web] = plan.members;
    // @ can't be in a release.tag template, so core's old tags are only read.
    expect(core!.release.tag).toBe("{member}/v{version}");
    expect(core!.release.legacyTags).toEqual(["@acme/core@"]);
    expect(web!.release.tag).toBe("web-v{version}");
    expect(web!.release.legacyTags).toBeUndefined();
  });

  test("a workspace with something the train can't carry gets one release, and says why", () => {
    expect(trainFit(detectProject(mono({ ".goreleaser.yaml": "builds:\n  - main: ./cmd/x\n" })))).toMatchObject({ train: false, why: expect.stringContaining(".goreleaser.yaml runs goreleaser at the repository root") });
    expect(trainFit(detectProject(mono({ "nfpm.yaml": "name: x\n" })))).toMatchObject({ train: false, why: expect.stringContaining("nfpm.yaml") });
    expect(trainFit(detectProject(mono({ "pom.xml": "<project><groupId>a</groupId><artifactId>b</artifactId></project>" })))).toMatchObject({ train: false, why: expect.stringContaining("pom.xml") });
    expect(trainFit(detectProject(mono({ "package.json": JSON.stringify({ name: "acme-mono", workspaces: ["packages/*"] }) })))).toMatchObject({ train: false, why: expect.stringContaining("root package acme-mono") });
    // #5216: GitLab renders the train too, so a GitLab project gets one, with the token its jobs push with.
    const gitlab = detectProject(mono());
    gitlab.workflowForge = "gitlab";
    expect(trainFit(gitlab)).toEqual({ train: true });
    const plan = planTrain(gitlab, PLAN);
    expect(plan.workflowFile).toBe(".gitlab/chant-release.yml");
    expect(plan.registry[0]).toContain("GitLab CI/CD naming");
    expect(plan.registry.at(-1)).toContain("CHANT_RELEASE_TOKEN");
    // One publishable package is no train, and nothing to explain.
    expect(trainFit(detectProject(repo({ "package.json": JSON.stringify({ name: "solo" }) })))).toEqual({ train: false, why: null });
  });
});

describe("a train with images, charts, extensions, Python and Rust (#5271)", () => {
  const mono = (extra: Record<string, string> = {}) =>
    repo({
      "package.json": JSON.stringify({ name: "acme-mono", private: true, workspaces: ["packages/*", "apps/*"] }),
      "package-lock.json": "{}",
      ".gitignore": "dist/\nbuild/\n",
      ".github/workflows/ci.yml": "on: push\n",
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", version: "0.0.0", files: ["dist"] }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "0.0.0", files: ["dist"], dependencies: { "@acme/core": "*" } }),
      ...extra,
    }, { origin: "git@github.com:acme/mono.git" });
  const member = (plan: ReturnType<typeof planTrain>, name: string) => {
    const m = plan.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member ${name} in ${plan.members.map((x) => x.name).join(", ")}`);
    return m;
  };

  test("a VS Code extension in the workspace is a member published to both marketplaces at its own version", () => {
    const facts = detectProject(mono({ "packages/ext/package.json": JSON.stringify({ name: "acme-vscode", publisher: "acme", version: "0.0.0", engines: { vscode: "^1.90.0" }, dependencies: { "@acme/core": "*" } }) }));
    expect(trainFit(facts)).toEqual({ train: true });
    const plan = planTrain(facts, PLAN);
    expect(plan.members.map((m) => [m.name, m.dir, m.package])).toEqual([
      ["core", "packages/core", "@acme/core"],
      ["acme-vscode", "packages/ext", "acme-vscode"],
      ["web", "packages/web", "@acme/web"],
    ]);
    expect(member(plan, "acme-vscode").release).toEqual({
      tag: "{member}/v{version}",
      green: "forge-checks",
      version: { packages: ["."], ranges: "train" },
      publish: [
        { type: "marketplace", marketplace: "vscode", vsix: "dist/acme-vscode.vsix" },
        { type: "marketplace", marketplace: "openvsx", vsix: "dist/acme-vscode.vsix", auth: "trusted-publishing" },
      ],
    });
    expect(plan.release.workflow).toEqual({ trigger: "dispatch", chant: "npx --yes @intentius/chant@0.124.101", env: { VSCE_PAT: "${{ secrets.VSCE_PAT }}" } });
    expect(plan.registry.filter((r) => r.startsWith("npm "))).toHaveLength(2);
    expect(plan.registry.join("\n")).toContain("VS Code Marketplace acme.acme-vscode");
    expect(plan.registry.join("\n")).toContain("Open VSX acme.acme-vscode");
    expect(plan.notes.join("\n")).toContain("The build must write packages/ext/dist/acme-vscode.vsix");
  });

  test("a Dockerfile in a member's directory is that member's image; one at the root gets release/<name> pointing back", () => {
    const plan = planTrain(detectProject(mono({ Dockerfile: "FROM scratch\n", "packages/web/Dockerfile": "FROM scratch\n", "apps/server/package.json": JSON.stringify({ name: "server", private: true }), "apps/server/Dockerfile": "FROM scratch\n" })), PLAN);
    expect(plan.members.map((m) => [m.name, m.dir])).toEqual([
      ["core", "packages/core"],
      ["web", "packages/web"],
      ["mono", "release/mono"],
      ["server", "release/server"],
    ]);
    // web publishes to npm, so its archive is written outside the dist npm packs.
    expect(member(plan, "web").release.images).toEqual([{ name: "web", dockerfile: "Dockerfile", archive: "build/images/web.tar" }]);
    expect(member(plan, "web").release.publish).toContainEqual({ type: "oci", image: "build/images/web.tar", repository: "ghcr.io/acme/mono/web" });
    expect(member(plan, "mono").release).toEqual({
      tag: "{member}/v{version}",
      green: "forge-checks",
      sources: ["../.."],
      images: [{ name: "mono", dockerfile: "../../Dockerfile", context: "../.." }],
      publish: [{ type: "oci", image: "dist/images/mono.tar", repository: "ghcr.io/acme/mono/mono" }],
    });
    // A private package is no member, so its Dockerfile's directory gets a member of its own.
    expect(member(plan, "server").release).toMatchObject({ sources: ["../../apps/server"], images: [{ name: "server", dockerfile: "../../apps/server/Dockerfile", context: "../../apps/server" }] });
    expect(plan.reasons.join("\n")).toContain("what no member's directory holds gets a member of its own at release/<name>");
    expect(plan.reasons.join("\n")).toContain('release/mono/chant.config.ts, member mono, a member of its own for the repository root (release.sources ["../.."])');
  });

  test("a chart outside the packages gets release/<name>; one inside a package is that member's, packed outside its dist", () => {
    const chart = (name: string) => `apiVersion: v2\nname: ${name}\nversion: 0.1.0\n`;
    const plan = planTrain(detectProject(mono({ "charts/api/Chart.yaml": chart("api"), "packages/web/chart/Chart.yaml": chart("web") })), PLAN);
    expect(member(plan, "api").dir).toBe("release/api");
    expect(member(plan, "api").release).toMatchObject({
      sources: ["../../charts/api"],
      artifacts: [{ name: "chart", helm: { chart: "../../charts/api" } }],
      publish: [{ type: "helm", charts: ["artifact:chart"], oci: { repository: "ghcr.io/acme/mono/charts" } }],
    });
    expect(member(plan, "web").release.artifacts).toEqual([{ name: "chart", helm: { chart: "chart", dir: "build" } }]);
    expect(plan.registry.filter((r) => r.startsWith("ghcr.io/acme/mono/charts"))).toHaveLength(1);
  });

  test("a Python package at the root is a member of its own: built into its dist, published to PyPI, its pyproject.toml stamped", () => {
    const facts = detectProject(mono({ "pyproject.toml": '[project]\nname = "acme-py"\nversion = "0.1.0"\n', Dockerfile: "FROM python\n" }));
    expect(trainFit(facts)).toEqual({ train: true });
    const plan = planTrain(facts, PLAN);
    // The root's Dockerfile builds from the same directory, so it goes to the same member.
    expect(member(plan, "acme-py").release).toEqual({
      tag: "{member}/v{version}",
      green: "forge-checks",
      sources: ["../.."],
      artifacts: [{ name: "python", build: "python -m pip install build && python -m build --outdir dist ../..", outputs: ["dist/*"] }],
      publish: [
        { type: "pypi", files: ["artifact:python"], auth: "trusted-publishing" },
        { type: "oci", image: "dist/images/mono.tar", repository: "ghcr.io/acme/mono" },
      ],
      version: { files: ["../../pyproject.toml"] },
      images: [{ name: "mono", dockerfile: "../../Dockerfile", context: "../.." }],
    });
    expect(plan.registry.join("\n")).toContain("PyPI acme-py: on pypi.org add a trusted publisher");
  });

  test("a Rust crate at the root is a member of its own that publishes the root's Cargo.toml", () => {
    const facts = detectProject(mono({ "Cargo.toml": '[package]\nname = "acme-rs"\nversion = "0.1.0"\n' }));
    expect(trainFit(facts)).toEqual({ train: true });
    const plan = planTrain(facts, PLAN);
    expect(member(plan, "acme-rs").release).toMatchObject({ sources: ["../.."], publish: [{ type: "cargo", manifest: "../../Cargo.toml" }], version: { files: ["../../Cargo.toml"] } });
    expect(member(plan, "acme-rs").dir).toBe("release/acme-rs");
    expect(plan.registry.join("\n")).toContain("crates.io acme-rs");
  });

  test("init --yes writes release/<name>, which chant loads, and a train workflow that builds its image", async () => {
    const root = mono({ Dockerfile: "FROM scratch\n" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runReleaseInit({ args: { yes: true } } as unknown as CommandContext)).toBe(0);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
    expect(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8")).members).toContainEqual({ name: "mono", dir: "release/mono", kind: "chant" });
    expect((await loadChantConfig(join(root, "release/mono"))).config.release).toMatchObject({ sources: ["../.."], images: [{ name: "mono", dockerfile: "../../Dockerfile", context: "../.." }] });
    expect(readFileSync(join(root, ".github/workflows/chant-release.yml"), "utf-8")).toContain("workspace train artifacts");
  });
});

describe("chant release init on a workspace (#5154)", () => {
  async function run(root: string, args: Record<string, unknown>): Promise<{ code: number; out: string }> {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      return { code: await runReleaseInit({ args } as unknown as CommandContext), out: lines.join("\n") };
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  }
  const mono = (extra: Record<string, string> = {}) =>
    repo({
      "package.json": JSON.stringify({ name: "acme-mono", private: true, workspaces: ["packages/*"] }),
      "package-lock.json": "{}",
      ".github/workflows/ci.yml": "on: push\n",
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", version: "0.0.0" }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "0.0.0", dependencies: { "@acme/core": "*" } }),
      ...extra,
    }, { origin: "https://github.com/acme/mono.git" });

  test("a dry run writes nothing; --yes writes the workspace, each member's config, the root's and the train workflow", async () => {
    const root = mono();
    const dry = await run(root, {});
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Dry run: a release train of 2 packages");
    expect(dry.out).toContain("--one-release");
    for (const f of ["chant.workspace.json", "chant.config.ts", "packages/core/chant.config.ts", ".github/workflows/chant-release.yml"]) expect(existsSync(join(root, f))).toBe(false);

    const wrote = await run(root, { yes: true });
    expect(wrote.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8"))).toEqual({
      name: "mono",
      schema: 1,
      members: [
        { name: "core", dir: "packages/core", kind: "chant" },
        { name: "web", dir: "packages/web", kind: "chant" },
      ],
    });
    expect((await loadChantConfig(root)).config.release).toMatchObject({ train: { env: "npm" }, workflow: { trigger: "dispatch" } });
    expect((await loadChantConfig(join(root, "packages/web"))).config.release).toMatchObject({ tag: "{member}/v{version}", version: { packages: ["."], ranges: "train" }, publish: [{ type: "npm", packages: ["."] }] });
    const workflowText = readFileSync(join(root, ".github/workflows/chant-release.yml"), "utf-8");
    expect(workflowText).toContain("name: chant release train");
    expect(workflowText).toContain("workspace train cut npm");
    expect(wrote.out).toContain("git add chant.workspace.json chant.config.ts packages/core/chant.config.ts packages/web/chant.config.ts .github/workflows/chant-release.yml");
    expect(wrote.out).toContain("gh workflow run chant-release.yml -f levels=auto");

    // Run again: every config has its release block, so nothing is replaced until --force.
    const again = await run(root, { yes: true });
    expect(again.code).toBe(1);
    expect(again.out).toContain("release-init-release-exists");
    expect((await run(root, { yes: true, force: true })).code).toBe(0);
  });

  test("an existing chant.workspace.json gets the members added; a member in the way is refused until --force", async () => {
    const root = mono({ "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "web", dir: "packages/web", kind: "other", because: "a package" }] }) });
    const r = await run(root, { yes: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release-init-member-exists");
    expect(existsSync(join(root, "packages/core/chant.config.ts"))).toBe(false);
    expect((await run(root, { yes: true, force: true })).code).toBe(0);
    const ws = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8")) as { name: string; members: unknown[] };
    expect(ws.name).toBe("acme");
    expect(ws.members).toEqual([
      { name: "web", dir: "packages/web", kind: "chant" },
      { name: "core", dir: "packages/core", kind: "chant" },
    ]);
  });

  test("--one-release keeps every package in one release", async () => {
    const root = mono();
    const doc = JSON.parse((await run(root, { json: true, oneRelease: true })).out) as { layout: string; release: { publish: unknown[] }; reasons: string[] };
    expect(doc.layout).toBe("one-release");
    expect(doc.release.publish).toEqual([{ type: "npm", packages: ["packages/core", "packages/web"], access: "public" }]);
    expect(doc.reasons[0]).toContain("--one-release");
    const train = JSON.parse((await run(root, { json: true })).out) as { layout: string; members: Array<{ name: string; config: string }> };
    expect(train.layout).toBe("train");
    expect(train.members.map((m) => m.config)).toEqual(["packages/core/chant.config.ts", "packages/web/chant.config.ts"]);
  });
});

describe("a workflow that already publishes to npm (#5235)", () => {
  const PUBLISH = "name: publish\non:\n  release:\n    types: [published]\npermissions:\n  id-token: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm publish --provenance --access public\n";
  const files = (extra: Record<string, string> = {}) => ({ "package.json": JSON.stringify({ name: "@acme/tool" }), "package-lock.json": "{}", ".github/workflows/ci.yml": "on: push\njobs: {}\n", ".github/workflows/publish.yml": PUBLISH, ...extra });

  test("the plan releases from it: release.workflow.file names it, and the trusted publisher that names it stays", () => {
    const facts = detectProject(repo(files(), { origin: "https://github.com/acme/tool.git" }));
    expect(facts.publishWorkflows).toEqual([".github/workflows/publish.yml"]);
    const plan = planRelease(facts, PLAN);
    expect(plan.workflowFile).toBe(".github/workflows/publish.yml");
    expect(plan.release.workflow).toMatchObject({ trigger: "dispatch", file: ".github/workflows/publish.yml" });
    expect(plan.registry[0]).toContain("the trusted publisher on npmjs.com that names acme/tool and the workflow file publish.yml keeps working");
    expect(plan.registry[0]).not.toContain("add a trusted publisher");
    expect(plan.reasons.some((r) => r.startsWith("release.workflow.file .github/workflows/publish.yml"))).toBe(true);
  });

  test("several such workflows adopt none and say so; a chant-generated one and a GitLab project adopt none", () => {
    const several = planRelease(detectProject(repo(files({ ".github/workflows/next.yml": "jobs:\n  p:\n    steps:\n      - run: pnpm publish --tag next\n" }))), PLAN);
    expect(several.workflowFile).toBe(".github/workflows/chant-release.yml");
    expect((several.release.workflow as { file?: string }).file).toBeUndefined();
    expect(several.notes.some((n) => n.includes("Several workflows run npm publish"))).toBe(true);

    const generated = detectProject(repo(files({ ".github/workflows/publish.yml": `# Generated by chant — do not edit directly. Regenerate with: chant release workflow\n${PUBLISH}` })));
    expect(generated.publishWorkflows).toEqual([]);

    const asGitlab = planRelease({ ...detectProject(repo(files())), workflowForge: "gitlab" }, PLAN);
    expect(asGitlab.workflowFile).toBe(".gitlab/chant-release.yml");
  });

  test("init --yes replaces it with the release workflow; release workflow then refuses a hand-written file without --force", async () => {
    const root = repo(files(), { origin: "https://github.com/acme/tool.git" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      expect(await runReleaseInit({ args: {} } as unknown as CommandContext)).toBe(0);
      expect(lines.join("\n")).toContain("replacing the .github/workflows/publish.yml there");
      expect(readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8")).toBe(PUBLISH);

      expect(await runReleaseInit({ args: { yes: true } } as unknown as CommandContext)).toBe(0);
      const text = readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8");
      expect(text).toContain("Generated by chant");
      expect(Object.keys((parseYAML(text) as { on: Record<string, unknown> }).on)).toEqual(["workflow_dispatch"]);
      expect(existsSync(join(root, ".github/workflows/chant-release.yml"))).toBe(false);
      expect((await loadChantConfig(root)).config.release?.workflow).toMatchObject({ file: ".github/workflows/publish.yml" });
      expect(lines.join("\n")).toContain("gh workflow run publish.yml");

      // A generated file is rewritten; a hand-written one is refused until --force.
      const { runReleaseWorkflow } = await import("../workspace/release-workflow");
      expect(await runReleaseWorkflow({ args: { forge: "github" } } as unknown as CommandContext)).toBe(0);
      writeFileSync(join(root, ".github/workflows/publish.yml"), PUBLISH);
      lines.length = 0;
      expect(await runReleaseWorkflow({ args: { forge: "github" } } as unknown as CommandContext)).toBe(1);
      expect(lines.join("\n")).toContain("release-workflow-exists");
      expect(readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8")).toBe(PUBLISH);
      expect(await runReleaseWorkflow({ args: { forge: "github", force: true } } as unknown as CommandContext)).toBe(0);
      expect(readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8")).toContain("Generated by chant");
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe("the supply-chain group (#5446)", () => {
  test("init leaves security as it is, and says what the group would add unless the workspace already opts in", () => {
    const plain = repo({ "package.json": JSON.stringify({ name: "@acme/app", version: "1.0.0" }) }, { origin: "git@github.com:acme/app.git" });
    const facts = detectProject(plain);
    expect(facts.security).toBeUndefined();
    const plan = planRelease(facts, PLAN);
    expect(plan.notes).toContain(SUPPLY_CHAIN_NOTE);
    expect(JSON.stringify(plan.release)).not.toContain("supply-chain");

    const opted = repo({ "package.json": JSON.stringify({ name: "@acme/app", version: "1.0.0" }), "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [], security: ["supply-chain"] }) }, { origin: "git@github.com:acme/app.git" });
    const optedFacts = detectProject(opted);
    expect(optedFacts.security).toEqual(["supply-chain"]);
    expect(planRelease(optedFacts, PLAN).notes).not.toContain(SUPPLY_CHAIN_NOTE);
  });
});
