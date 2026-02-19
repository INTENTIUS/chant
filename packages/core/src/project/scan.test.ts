import { describe, test, expect } from "bun:test";
import { scanProject } from "./scan";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("scanProject", () => {
  test("finds barrel and extracts lexicon package", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\nexport * from "./storage";\n`,
      );
      await writeFile(
        join(dir, "storage.ts"),
        `import * as td from "@intentius/chant-lexicon-testdom";\nexport const bucket = new td.Bucket({});\n`,
      );

      const scan = scanProject(dir);
      expect(scan.barrelPath).toBe(join(dir, "_.ts"));
      expect(scan.lexiconPackage).toBe("@intentius/chant-lexicon-testdom");
    });
  });

  test("collects exports from sibling files", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "storage.ts"),
        `import * as td from "@intentius/chant-lexicon-testdom";\nexport const dataBucket = new td.Bucket({});\nexport const logsBucket = new td.Bucket({});\n`,
      );
      await writeFile(
        join(dir, "compute.ts"),
        `import * as td from "@intentius/chant-lexicon-testdom";\nexport const handler = new td.Function({});\n`,
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(3);
      const names = scan.exports.map((e) => e.name);
      expect(names).toContain("dataBucket");
      expect(names).toContain("logsBucket");
      expect(names).toContain("handler");
    });
  });

  test("infers class names from new X.ClassName(...) patterns", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "resources.ts"),
        [
          `import * as td from "@intentius/chant-lexicon-testdom";`,
          `export const bucket = new td.Bucket({});`,
          `export const role = new td.Role({});`,
          `export const fn = new td.Function({});`,
        ].join("\n"),
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(3);

      const bucket = scan.exports.find((e) => e.name === "bucket");
      expect(bucket?.className).toBe("Bucket");

      const role = scan.exports.find((e) => e.name === "role");
      expect(role?.className).toBe("Role");

      const fn = scan.exports.find((e) => e.name === "fn");
      expect(fn?.className).toBe("Function");
    });
  });

  test("infers class names from type annotations", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "config.ts"),
        [
          `import * as td from "@intentius/chant-lexicon-testdom";`,
          `export const encryption: td.ServerSideEncryptionByDefault = { sseAlgorithm: "AES256" };`,
          `export const versioning: td.VersioningConfiguration = { status: "Enabled" };`,
        ].join("\n"),
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(2);

      const encryption = scan.exports.find((e) => e.name === "encryption");
      expect(encryption?.className).toBe("ServerSideEncryptionByDefault");

      const versioning = scan.exports.find((e) => e.name === "versioning");
      expect(versioning?.className).toBe("VersioningConfiguration");
    });
  });

  test("excludes barrel, test files, and underscore-prefixed files", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "_internal.ts"),
        `export const secret = "hidden";\n`,
      );
      await writeFile(
        join(dir, "app.test.ts"),
        `import { test } from "bun:test";\ntest("passes", () => {});\n`,
      );
      await writeFile(
        join(dir, "app.spec.ts"),
        `import { test } from "bun:test";\ntest("passes", () => {});\n`,
      );
      await writeFile(
        join(dir, "app.ts"),
        `export const app = "hello";\n`,
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(1);
      expect(scan.exports[0].name).toBe("app");
    });
  });

  test("throws on missing barrel", async () => {
    await withTestDir(async (dir) => {
      expect(() => scanProject(dir)).toThrow("No barrel file found");
    });
  });

  test("returns empty className for exports without recognizable patterns", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "utils.ts"),
        `export const greeting = "hello";\nexport const count = 42;\n`,
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(2);
      for (const exp of scan.exports) {
        expect(exp.className).toBe("");
      }
    });
  });

  test("infers class names from new _.ClassName(...) patterns", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "resources.ts"),
        [
          `import * as _ from "./_";`,
          `export const bucket = new _.Bucket({});`,
        ].join("\n"),
      );

      const scan = scanProject(dir);
      expect(scan.exports).toHaveLength(1);
      expect(scan.exports[0].className).toBe("Bucket");
    });
  });
});
