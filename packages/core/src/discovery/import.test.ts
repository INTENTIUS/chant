import { describe, test, expect } from "bun:test";
import { importModule } from "./import";
import { DiscoveryError } from "../errors";
import { withTestDir, expectToThrow } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("importModule", () => {

  test("imports a valid module and returns exports", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "module.ts");
      await writeFile(
        filePath,
        'export const greeting = "hello";\nexport const count = 42;'
      );

      const module = await importModule(filePath);
      expect(module.greeting).toBe("hello");
      expect(module.count).toBe(42);
    });
  });

  test("imports module with default export", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "default.ts");
      await writeFile(filePath, "export default { name: 'test', value: 123 };");

      const module = await importModule(filePath);
      expect(module.default).toBeDefined();
      expect(module.default.name).toBe("test");
      expect(module.default.value).toBe(123);
    });
  });

  test("imports module with mixed exports", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "mixed.ts");
      await writeFile(
        filePath,
        'export default "main";\nexport const helper = "utils";\nexport const version = 1;'
      );

      const module = await importModule(filePath);
      expect(module.default).toBe("main");
      expect(module.helper).toBe("utils");
      expect(module.version).toBe(1);
    });
  });

  test("imports module with no exports", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "empty.ts");
      await writeFile(filePath, "const internal = 42;");

      const module = await importModule(filePath);
      expect(module).toBeDefined();
      expect(Object.keys(module)).not.toContain("internal");
    });
  });

  test("throws DiscoveryError with type 'import' for non-existent file", async () => {
    await withTestDir(async (testDir) => {
      const nonExistentPath = join(testDir, "does-not-exist.ts");

      const error = await expectToThrow(
        () => importModule(nonExistentPath),
        DiscoveryError,
        (err) => {
          expect(err.type).toBe("import");
          expect(err.file).toBe(nonExistentPath);
          expect(err.message).toBeDefined();
        }
      );
    });
  });

  test("throws DiscoveryError with type 'import' for invalid syntax", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "invalid.ts");
      await writeFile(filePath, "export const broken = {");

      await expectToThrow(
        () => importModule(filePath),
        DiscoveryError,
        (error) => {
          expect(error.type).toBe("import");
          expect(error.file).toBe(filePath);
          expect(error.message).toBeDefined();
        }
      );
    });
  });

  test("throws DiscoveryError with type 'import' for runtime error", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "runtime-error.ts");
      await writeFile(
        filePath,
        'throw new Error("Module initialization failed");'
      );

      await expectToThrow(
        () => importModule(filePath),
        DiscoveryError,
        (error) => {
          expect(error.type).toBe("import");
          expect(error.file).toBe(filePath);
          expect(error.message).toContain("Module initialization failed");
        }
      );
    });
  });

  test("imports module with class exports", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "class.ts");
      await writeFile(
        filePath,
        `export class MyClass {
        constructor(public value: number) {}
        getValue() { return this.value; }
      }`
      );

      const module = await importModule(filePath);
      expect(module.MyClass).toBeDefined();
      const instance = new module.MyClass(100);
      expect(instance.getValue()).toBe(100);
    });
  });

  test("imports module with function exports", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "functions.ts");
      await writeFile(
        filePath,
        `export function add(a: number, b: number) { return a + b; }
       export const multiply = (a: number, b: number) => a * b;`
      );

      const module = await importModule(filePath);
      expect(module.add).toBeInstanceOf(Function);
      expect(module.multiply).toBeInstanceOf(Function);
      expect(module.add(2, 3)).toBe(5);
      expect(module.multiply(4, 5)).toBe(20);
    });
  });

  test("imports module with re-exports", async () => {
    await withTestDir(async (testDir) => {
      const utilsPath = join(testDir, "utils.ts");
      const indexPath = join(testDir, "index.ts");

      await writeFile(utilsPath, 'export const util = "helper";');
      await writeFile(indexPath, 'export { util } from "./utils.ts";');

      const module = await importModule(indexPath);
      expect(module.util).toBe("helper");
    });
  });

  test("preserves error message from underlying import failure", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "missing-dep.ts");
      await writeFile(
        filePath,
        'import { nonExistent } from "./does-not-exist.ts";\nexport const value = nonExistent;'
      );

      await expectToThrow(
        () => importModule(filePath),
        DiscoveryError,
        (error) => {
          expect(error.type).toBe("import");
          expect(error.file).toBe(filePath);
          expect(error.message.length).toBeGreaterThan(0);
        }
      );
    });
  });

  test("error serializes to JSON correctly", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "bad.ts");

      const error = await expectToThrow(
        () => importModule(filePath),
        DiscoveryError
      );

      const json = error.toJSON();
      expect(json.name).toBe("DiscoveryError");
      expect(json.file).toBe(filePath);
      expect(json.type).toBe("import");
      expect(json.message).toBeDefined();
    });
  });
});
