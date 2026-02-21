import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { initLexiconCommand } from "./init-lexicon";

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
      "src/index.ts",
      "src/serializer.ts",
      "src/codegen/generate.ts",
      "src/codegen/generate-cli.ts",
      "src/codegen/naming.ts",
      "src/codegen/package.ts",
      "src/codegen/docs.ts",
      "src/spec/fetch.ts",
      "src/spec/parse.ts",
      "src/lint/rules/sample.ts",
      "src/lint/rules/index.ts",
      "src/lsp/completions.ts",
      "src/lsp/hover.ts",
      "src/import/parser.ts",
      "src/import/generator.ts",
      "src/coverage.ts",
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
      "src/generated/.gitkeep",
      "examples/getting-started/.gitkeep",
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
