import { describe, test, expect } from "bun:test";
import { initCommand, type InitOptions } from "./init";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("initCommand", () => {
  test("creates project with aws lexicon", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      const result = await initCommand(options);

      expect(result.success).toBe(true);
      expect(result.createdFiles).toContain("package.json");
      expect(result.createdFiles).toContain("tsconfig.json");
      expect(result.createdFiles).toContain("chant.config.ts");
      expect(result.createdFiles).toContain(".gitignore");
      expect(result.createdFiles).toContain("src/_.ts");
      expect(result.createdFiles).toContain("src/config.ts");
      expect(result.createdFiles).toContain("src/data-bucket.ts");
      expect(result.createdFiles).toContain("src/logs-bucket.ts");
    });
  });

  test("aws source files use namespace imports", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const configContent = readFileSync(join(testDir, "src", "config.ts"), "utf-8");
      expect(configContent).toContain('import * as aws from "@intentius/chant-lexicon-aws"');

      const dataBucketContent = readFileSync(join(testDir, "src", "data-bucket.ts"), "utf-8");
      expect(dataBucketContent).toContain('import * as aws from "@intentius/chant-lexicon-aws"');
      expect(dataBucketContent).toContain('import * as _ from "./_"');

      const logsBucketContent = readFileSync(join(testDir, "src", "logs-bucket.ts"), "utf-8");
      expect(logsBucketContent).toContain('import * as aws from "@intentius/chant-lexicon-aws"');
      expect(logsBucketContent).toContain('import * as _ from "./_"');
    });
  });

  test("aws generates two resource files for split pattern", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      expect(existsSync(join(testDir, "src", "data-bucket.ts"))).toBe(true);
      expect(existsSync(join(testDir, "src", "logs-bucket.ts"))).toBe(true);
    });
  });

  test("generates valid package.json with build and dev scripts", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const pkgPath = join(testDir, "package.json");
      expect(existsSync(pkgPath)).toBe(true);

      const content = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content);

      expect(pkg.dependencies["@intentius/chant"]).toBeDefined();
      expect(pkg.dependencies["@intentius/chant-lexicon-aws"]).toBeDefined();
      expect(pkg.devDependencies["typescript"]).toBeDefined();
      expect(pkg.scripts.build).toBe("chant build src --lexicon aws");
      expect(pkg.scripts.dev).toBe("chant build src --lexicon aws --watch");
      expect(pkg.scripts.lint).toBe("chant lint src");
    });
  });

  test("generates valid tsconfig.json with path mappings", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const tsconfigPath = join(testDir, "tsconfig.json");
      expect(existsSync(tsconfigPath)).toBe(true);

      const content = readFileSync(tsconfigPath, "utf-8");
      const tsconfig = JSON.parse(content);

      expect(tsconfig.compilerOptions.strict).toBe(true);
      expect(tsconfig.compilerOptions.rootDir).toBe("./src");
      expect(tsconfig.include).toContain("src");
      expect(tsconfig.compilerOptions.paths["@intentius/chant"]).toEqual(["./.chant/types/core"]);
      expect(tsconfig.compilerOptions.paths["@intentius/chant-lexicon-aws"]).toEqual(["./.chant/types/lexicon-aws"]);
    });
  });

  test("creates src directory", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const srcDir = join(testDir, "src");
      expect(existsSync(srcDir)).toBe(true);
    });
  });

  test("generates chant.config.ts with lexicons", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const configPath = join(testDir, "chant.config.ts");
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain('lexicons: ["aws"]');
      expect(content).toContain("ChantConfig");
    });
  });

  test("generates .gitignore with .chant/ entries", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const gitignorePath = join(testDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);

      const content = readFileSync(gitignorePath, "utf-8");
      expect(content).toContain("dist/");
      expect(content).toContain("node_modules/");
      expect(content).toContain(".chant/types/");
    });
  });

  test("generates barrel file", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      const barrelPath = join(testDir, "src", "_.ts");
      expect(existsSync(barrelPath)).toBe(true);

      const barrelContent = readFileSync(barrelPath, "utf-8");
      expect(barrelContent).toContain('export * from "./config"');

      // No index.ts — barrel re-exports cause duplicate entity errors during build
      const indexPath = join(testDir, "src", "index.ts");
      expect(existsSync(indexPath)).toBe(false);
    });
  });

  test("scaffolds .chant/types/ with core and lexicon stubs", async () => {
    await withTestDir(async (testDir) => {
      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      await initCommand(options);

      // Core types
      const coreDts = join(testDir, ".chant", "types", "core", "index.d.ts");
      expect(existsSync(coreDts)).toBe(true);
      const coreContent = readFileSync(coreDts, "utf-8");
      expect(coreContent).toContain("Value<T>");
      expect(coreContent).toContain("Serializer");
      expect(coreContent).toContain("ChantConfig");
      expect(coreContent).toContain("barrel");

      const corePkg = join(testDir, ".chant", "types", "core", "package.json");
      expect(existsSync(corePkg)).toBe(true);
      const corePkgContent = JSON.parse(readFileSync(corePkg, "utf-8"));
      expect(corePkgContent.name).toBe("@intentius/chant");

      // Lexicon types stub
      const lexDts = join(testDir, ".chant", "types", "lexicon-aws", "index.d.ts");
      expect(existsSync(lexDts)).toBe(true);

      const lexPkg = join(testDir, ".chant", "types", "lexicon-aws", "package.json");
      expect(existsSync(lexPkg)).toBe(true);
      const lexPkgContent = JSON.parse(readFileSync(lexPkg, "utf-8"));
      expect(lexPkgContent.name).toBe("@intentius/chant-lexicon-aws");
    });
  });

  test("fails in non-empty directory without force", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "existing.txt"), "content");

      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      const result = await initCommand(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not empty");
    });
  });

  test("succeeds in non-empty directory with force", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "existing.txt"), "content");

      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
        force: true,
      };

      const result = await initCommand(options);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  test("skips existing files", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "package.json"), '{"existing": true}');

      const options: InitOptions = {
        path: testDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
        force: true,
      };

      const result = await initCommand(options);

      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("package.json"))).toBe(true);
      expect(result.createdFiles).not.toContain("package.json");

      const content = readFileSync(join(testDir, "package.json"), "utf-8");
      expect(content).toContain("existing");
    });
  });

  test("creates directory if it doesn't exist", async () => {
    await withTestDir(async (testDir) => {
      const newDir = join(testDir, "new-project");

      const options: InitOptions = {
        path: newDir,
        lexicon: "aws",
        skipMcp: true,
        skipInstall: true,
      };

      const result = await initCommand(options);

      expect(result.success).toBe(true);
      expect(existsSync(newDir)).toBe(true);
    });
  });
});

