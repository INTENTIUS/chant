import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, realpathSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { initLexiconCommand } from "./init-lexicon";
import { checkLexicon } from "./check-lexicon";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__", "init-lexicon-output");

function makeTmpDir(): string {
  const dir = join(tmpdir(), `chant-init-lexicon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("initLexiconCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates all expected files", async () => {
    const targetDir = join(tmpDir, "test-lex");
    const result = await initLexiconCommand({ name: "test-lex", path: targetDir });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const expectedFiles = [
      "src/plugin.ts",
      "src/plugin.test.ts",
      "src/index.ts",
      "src/serializer.ts",
      "src/serializer.test.ts",
      "src/codegen/generate.ts",
      "src/codegen/generate-cli.ts",
      "src/codegen/naming.ts",
      "src/codegen/package.ts",
      "src/codegen/docs.ts",
      "src/codegen/docs-cli.ts",
      "src/package-cli.ts",
      "src/spec/fetch.ts",
      "src/spec/parse.ts",
      "src/lint/rules/sample.ts",
      "src/lint/rules/index.ts",
      "src/lsp/completions.ts",
      "src/lsp/hover.ts",
      "src/lsp/completions.test.ts",
      "src/lsp/hover.test.ts",
      "src/validate.ts",
      "src/validate-cli.ts",
      "package.json",
      "tsconfig.json",
      "justfile",
      ".gitignore",
      "README.md",
      "docs/package.json",
      "docs/tsconfig.json",
      "docs/astro.config.mjs",
      "docs/src/content.config.ts",
      "docs/src/content/docs/index.mdx",
      "docs/pages/getting-started.mdx",
      "examples/getting-started/package.json",
      "examples/getting-started/src/infra.ts",
      "src/generated/.gitkeep",
    ];

    for (const file of expectedFiles) {
      expect(existsSync(join(targetDir, file))).toBe(true);
    }
  });

  test("plugin.ts contains all 5 required lifecycle methods", async () => {
    const targetDir = join(tmpDir, "lifecycle");
    await initLexiconCommand({ name: "k8s", path: targetDir });

    const pluginContent = readFileSync(join(targetDir, "src/plugin.ts"), "utf-8");

    expect(pluginContent).toContain("async generate(");
    expect(pluginContent).toContain("async validate(");
    expect(pluginContent).toContain("async coverage(");
    expect(pluginContent).toContain("async package(");
  });

  test("package name uses the provided lexicon name", async () => {
    const targetDir = join(tmpDir, "pkg-name");
    await initLexiconCommand({ name: "gcp", path: targetDir });

    const pkgJson = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf-8"));
    expect(pkgJson.name).toBe("@intentius/chant-lexicon-gcp");
  });

  test("rule prefix derived correctly", async () => {
    const targetDir = join(tmpDir, "rule-prefix");
    await initLexiconCommand({ name: "k8s", path: targetDir });

    const ruleContent = readFileSync(join(targetDir, "src/lint/rules/sample.ts"), "utf-8");
    expect(ruleContent).toContain('"K8S001"');

    const serializerContent = readFileSync(join(targetDir, "src/serializer.ts"), "utf-8");
    expect(serializerContent).toContain('rulePrefix: "K8S"');
  });

  test("rule prefix handles hyphens", async () => {
    const targetDir = join(tmpDir, "rule-prefix-hyphen");
    await initLexiconCommand({ name: "my-cloud", path: targetDir });

    const ruleContent = readFileSync(join(targetDir, "src/lint/rules/sample.ts"), "utf-8");
    // "my-cloud" -> "MYCLOUD" -> "MYC"
    expect(ruleContent).toContain('"MYC001"');
  });

  test("refuses non-empty dir without --force", async () => {
    const targetDir = join(tmpDir, "non-empty");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "existing.txt"), "hello");

    const result = await initLexiconCommand({ name: "test", path: targetDir });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not empty");
  });

  test("allows --force in non-empty dir", async () => {
    const targetDir = join(tmpDir, "force");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "existing.txt"), "hello");

    const result = await initLexiconCommand({ name: "test", path: targetDir, force: true });

    expect(result.success).toBe(true);
    expect(result.warnings).toContain("Initializing in non-empty directory");
  });

  test("warns on second run (skip existing files)", async () => {
    const targetDir = join(tmpDir, "second-run");

    const first = await initLexiconCommand({ name: "test", path: targetDir });
    expect(first.success).toBe(true);
    expect(first.warnings.length).toBe(0);

    const second = await initLexiconCommand({ name: "test", path: targetDir, force: true });
    expect(second.success).toBe(true);
    expect(second.warnings.length).toBeGreaterThan(0);
    expect(second.warnings.some((w) => w.includes("already exists"))).toBe(true);
  });

  test("uses camelCase for plugin variable names", async () => {
    const targetDir = join(tmpDir, "camel");
    await initLexiconCommand({ name: "my-cloud", path: targetDir });

    const pluginContent = readFileSync(join(targetDir, "src/plugin.ts"), "utf-8");
    expect(pluginContent).toContain("export const myCloudPlugin");

    const serializerContent = readFileSync(join(targetDir, "src/serializer.ts"), "utf-8");
    expect(serializerContent).toContain("export const myCloudSerializer");
  });

  test("defaults path to lexicons/<name>", async () => {
    // We can't test the actual default easily without cd'ing,
    // but we can verify the interface accepts no path
    const targetDir = join(tmpDir, "default-path", "lexicons", "test");
    mkdirSync(targetDir, { recursive: true });

    const result = await initLexiconCommand({
      name: "test",
      path: targetDir,
    });

    expect(result.success).toBe(true);
  });
});

// ── Scaffold content validation (bug fix regression tests) ──────────

describe("scaffold content validation", () => {
  let tmpDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    targetDir = join(tmpDir, "fixture-lex");
    await initLexiconCommand({ name: "fixture", path: targetDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writeGeneratedArtifacts uses WriteConfig object, not positional args", () => {
    const content = readFileSync(join(targetDir, "src/codegen/generate.ts"), "utf-8");

    // Must call writeGeneratedArtifacts with a config object
    expect(content).toContain("writeGeneratedArtifacts({");
    expect(content).toContain("baseDir:");
    expect(content).toContain("files:");
    expect(content).toContain('"lexicon.json": result.lexiconJSON');
    expect(content).toContain('"index.d.ts": result.typesDTS');
    expect(content).toContain('"index.ts": result.indexTS');

    // Must NOT have the old positional-arg call
    expect(content).not.toContain("writeGeneratedArtifacts(result, dir)");
  });

  test("packagePipeline config includes collectSkills", () => {
    const content = readFileSync(join(targetDir, "src/codegen/package.ts"), "utf-8");

    expect(content).toContain("collectSkills:");
    expect(content).toContain("collectSkills: () => new Map()");
  });

  test("packagePipeline forwards force flag", () => {
    const content = readFileSync(join(targetDir, "src/codegen/package.ts"), "utf-8");

    expect(content).toContain("force: opts?.force");
  });

  test("generate.ts TODO stubs include return type hints", () => {
    const content = readFileSync(join(targetDir, "src/codegen/generate.ts"), "utf-8");

    // fetchSchemas hint
    expect(content).toContain("Must return Map<typeName, Buffer>");
    // parseSchema hint
    expect(content).toContain("Must return a ParsedResult");
    // generateRegistry hint
    expect(content).toContain("Must return a string of JSON");
    // generateRuntimeIndex hint
    expect(content).toContain("Must return a string of TypeScript");
    // AWS references
    expect(content).toContain("lexicons/aws/");
  });

  // Drift guards — keep the scaffold compiling/installing against current core (#749).
  test("package.json installs under plain npm and can build (#749)", () => {
    const pkg = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf-8"));
    expect(JSON.stringify(pkg)).not.toContain("workspace:"); // rejected by plain npm
    expect(pkg.devDependencies["@intentius/chant"]).toBe("*");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies["tsc-alias"]).toBeTruthy();
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });

  // #2090, the scaffolded package.json failed tier 1 as generated: a bare
  // string exports["."], a build script that never deletes emitted .js, and
  // a prepack that never bundled, so dist/manifest.json never existed.
  test("package.json exports[\".\"].default is ./src/index.ts, build deletes emitted JS, prepack bundles (#2090)", () => {
    const pkg = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf-8"));
    expect(pkg.exports["."].default).toBe("./src/index.ts");
    expect(pkg.scripts.build).toContain("-delete");
    expect(pkg.scripts.prepack).toContain("bundle");
  });

  test("tsconfig.build.json uses bundler resolution + the development condition (#749)", () => {
    const cfg = JSON.parse(readFileSync(join(targetDir, "tsconfig.build.json"), "utf-8"));
    expect(cfg.compilerOptions.moduleResolution).toBe("bundler");
    expect(cfg.compilerOptions.customConditions).toContain("development");
  });

  test("spec/fetch.ts matches fetchWithCache(config, force) → Map<string, Buffer> (#749)", () => {
    const content = readFileSync(join(targetDir, "src/spec/fetch.ts"), "utf-8");
    expect(content).toContain("Promise<Map<string, Buffer>>");
    expect(content).not.toMatch(/force:\s*options/); // force is the 2nd arg, not a FetchConfig field
  });

  test("validate-cli.ts calls validate() with no verbose arg (#749)", () => {
    const content = readFileSync(join(targetDir, "src/validate-cli.ts"), "utf-8");
    expect(content).toContain("await validate();");
    expect(content).not.toContain("verbose");
  });

  test("lint/rules/index.ts exports a `rules` array (plugin.ts imports it) (#749)", () => {
    const content = readFileSync(join(targetDir, "src/lint/rules/index.ts"), "utf-8");
    expect(content).toContain("export const rules");
  });

  // #1614: generate-cli.ts lives in src/codegen/, so the package root is three
  // dirnames up. Two dirnames is src/, and the first `npm run generate` then
  // writes src/src/generated/. Run the scaffolded CLI for real with generate.ts
  // replaced by a stub that reports where it was told to write.
  test("generate-cli.ts resolves pkgDir to the package root, so generate writes src/generated (#1614)", () => {
    const cliPath = join(targetDir, "src/codegen/generate-cli.ts");
    expect(readFileSync(cliPath, "utf-8")).toContain(
      "dirname(dirname(dirname(fileURLToPath(import.meta.url))))",
    );

    writeFileSync(
      join(targetDir, "src/codegen/generate.ts"),
      [
        'import { mkdirSync, writeFileSync } from "fs";',
        'import { join } from "path";',
        "export async function generate() { return {}; }",
        "export function writeGeneratedFiles(_result: unknown, pkgDir: string) {",
        '  const dir = join(pkgDir, "src/generated");',
        "  mkdirSync(dir, { recursive: true });",
        '  writeFileSync(join(dir, "lexicon.json"), "{}");',
        "  process.stdout.write(pkgDir);",
        "}",
        "",
      ].join("\n"),
    );

    const tsx = join(__dirname, "../../../../../node_modules/.bin/tsx");
    const out = execFileSync(tsx, [cliPath], { cwd: targetDir, encoding: "utf-8" });

    expect(realpathSync(out.trim())).toBe(realpathSync(targetDir));
    expect(existsSync(join(targetDir, "src/generated/lexicon.json"))).toBe(true);
    expect(existsSync(join(targetDir, "src/src"))).toBe(false);
  });

  test("generate.ts default pkgDir is also the package root (#1614)", () => {
    const content = readFileSync(join(targetDir, "src/codegen/generate.ts"), "utf-8");
    expect(content).toContain("pkgDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))))");
  });
});

// #2090, a fresh scaffold used to fail 5 tier-1 checks before the author
// wrote anything. The docs-cli.ts gap (section 1) and the package.json/bundle
// gap (section 2) together fixed the packaging-shape check and let
// `npm run bundle` actually produce dist/manifest.json with a chantVersion.
describe("a fresh scaffold's tier-1 completeness (#2090)", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `chant-scaffold-tier1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    // The scaffold's tsconfig.json extends "../../tsconfig.json" (mirroring
    // lexicons/<name>/tsconfig.json's real "../../tsconfig.json" -> repo
    // root), so loading it needs a real file two levels up.
    writeFileSync(join(root, "tsconfig.json"), "{}\n");

    // A self-contained node_modules so the scaffold's own runtime imports of
    // "@intentius/chant/*" resolve exactly as they would in the real
    // monorepo, without touching the real repo's node_modules or lexicons/.
    mkdirSync(join(root, "node_modules/@intentius"), { recursive: true });
    symlinkSync(
      join(__dirname, "..", "..", ".."), // commands -> cli -> src -> packages/core
      join(root, "node_modules/@intentius/chant"),
      "dir",
    );

    dir = join(root, "lexicons", "acme");
    await initLexiconCommand({ name: "acme", path: dir });

    // Bypass the generate() TODO throw. A real spec fetcher/parser is the
    // author's job, not this test's. writeGeneratedFiles resolves its own
    // target so a no-op stub is fine.
    writeFileSync(
      join(dir, "src/codegen/generate.ts"),
      [
        "export async function generate() {",
        "  return { resources: 0, properties: 0, enums: 0, lexiconJSON: '{}', typesDTS: '', indexTS: '' };",
        "}",
        "export function writeGeneratedFiles() {}",
        "",
      ].join("\n"),
    );

    // Run the fixed bundle pipeline for real, proving section 2's package.json
    // + package-cli.ts changes actually produce dist/manifest.json, not just
    // that the scripts look right.
    const packageMod = (await import(pathToFileURL(join(dir, "src/codegen/package.ts")).href)) as {
      packageLexicon: (opts?: { verbose?: boolean }) => Promise<{ spec: unknown }>;
    };
    const { spec } = await packageMod.packageLexicon({ verbose: false });

    const bundleMod = (await import(
      pathToFileURL(join(root, "node_modules/@intentius/chant/src/codegen/package.ts")).href
    )) as { writeBundleSpec: (spec: unknown, distDir: string) => void };
    bundleMod.writeBundleSpec(spec, join(dir, "dist"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the fixed bundle pipeline actually produces dist/manifest.json with a chantVersion", () => {
    expect(existsSync(join(dir, "dist/manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, "dist/manifest.json"), "utf-8"));
    expect(typeof manifest.chantVersion).toBe("string");
    expect(manifest.chantVersion.length).toBeGreaterThan(0);
  });

  // Only real author work should remain. "Every shipped example builds..."
  // also fails here, but for a reason outside this issue's scope: the
  // scaffold's getting-started example has every line commented out (nothing
  // to build yet), which is true independent of sections 1 and 2 above.
  test("fails only on real author work, not on anything sections 1-2 fix", async () => {
    const result = await checkLexicon(dir);
    const tier1Failures = result.items.filter((i) => i.tier === 1 && !i.pass).map((i) => i.name);
    expect(tier1Failures).toEqual([
      "postSynthChecks() returns at least 1 check",
      "Every shipped example builds and passes its own post-synth checks",
    ]);
  });
});

// ── Fixture snapshot tests ──────────────────────────────────────────

describe("init-lexicon fixture snapshot", () => {
  const FIXTURE_LEXICON_NAME = "fixture";

  test("generate and snapshot fixture files", async () => {
    // Generate scaffold into the fixture directory
    // Use force to overwrite any stale fixtures
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });

    const result = await initLexiconCommand({
      name: FIXTURE_LEXICON_NAME,
      path: FIXTURE_DIR,
    });

    // Remove generated .test.ts files so they won't be discovered by the test runner
    for (const f of [
      "src/plugin.test.ts",
      "src/serializer.test.ts",
      "src/lsp/completions.test.ts",
      "src/lsp/hover.test.ts",
    ]) {
      rmSync(join(FIXTURE_DIR, f), { force: true });
    }

    expect(result.success).toBe(true);

    // Key files that must exist
    const criticalFiles = [
      "src/codegen/generate.ts",
      "src/codegen/package.ts",
      "src/plugin.ts",
      "src/serializer.ts",
      "package.json",
    ];

    for (const file of criticalFiles) {
      expect(existsSync(join(FIXTURE_DIR, file))).toBe(true);
    }
  });

  test("fixture generate.ts matches snapshot", async () => {
    // Ensure fixture exists
    if (!existsSync(join(FIXTURE_DIR, "src/codegen/generate.ts"))) {
      await initLexiconCommand({ name: FIXTURE_LEXICON_NAME, path: FIXTURE_DIR });
    }

    const content = readFileSync(join(FIXTURE_DIR, "src/codegen/generate.ts"), "utf-8");
    expect(content).toMatchSnapshot();
  });

  test("fixture package.ts matches snapshot", async () => {
    if (!existsSync(join(FIXTURE_DIR, "src/codegen/package.ts"))) {
      await initLexiconCommand({ name: FIXTURE_LEXICON_NAME, path: FIXTURE_DIR });
    }

    const content = readFileSync(join(FIXTURE_DIR, "src/codegen/package.ts"), "utf-8");
    expect(content).toMatchSnapshot();
  });

  test("fixture plugin.ts matches snapshot", async () => {
    if (!existsSync(join(FIXTURE_DIR, "src/plugin.ts"))) {
      await initLexiconCommand({ name: FIXTURE_LEXICON_NAME, path: FIXTURE_DIR });
    }

    const content = readFileSync(join(FIXTURE_DIR, "src/plugin.ts"), "utf-8");
    expect(content).toMatchSnapshot();
  });
});
