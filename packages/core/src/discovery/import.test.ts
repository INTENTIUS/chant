import { describe, test, expect } from "vitest";
import { importModule, resetImportFailures } from "./import";
import { discover } from "./index";
import { DiscoveryError } from "../errors";
import { withTestDir, expectToThrow } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
      expect((module.default as Record<string, unknown>).name).toBe("test");
      expect((module.default as Record<string, unknown>).value).toBe(123);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance = new (module.MyClass as any)(100);
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
      expect((module.add as Function)(2, 3)).toBe(5);
      expect((module.multiply as Function)(4, 5)).toBe(20);
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

describe("a module whose evaluation threw stays thrown (#2368)", () => {
  /**
   * The spec records an evaluation failure on the module record and re-throws
   * it on every later import, forever. Node does that; vitest's module runner
   * does not, and hands the second importer a namespace holding whatever was
   * initialized before the throw.
   *
   * These assert the contract directly. They do not reproduce the runner bug —
   * a module written to a temp directory is outside vitest's transform root and
   * is imported by Node, which already records the failure. The reproduction is
   * the corpus-backed test at the bottom of this file, which is the one that
   * fails without the failure map.
   */
  test("a second import throws the same error, not a half-initialized namespace", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "throws.ts");
      await writeFile(filePath, `const o = undefined as unknown as { k: string };\nexport const value = o.k;\n`);

      const first = await expectToThrow(() => importModule(filePath), DiscoveryError);
      const second = await expectToThrow(() => importModule(filePath), DiscoveryError);

      expect(second.message).toBe(first.message);
      expect(second.file).toBe(filePath);
      // The same error object, because it is the recorded one being replayed
      // rather than a second failure that happened to look alike.
      expect(second).toBe(first);
    });
  });

  test("a third and fourth import keep throwing", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "throws-again.ts");
      await writeFile(filePath, `const o = undefined as unknown as { k: string };\nexport const value = o.k;\n`);

      await expectToThrow(() => importModule(filePath), DiscoveryError);
      await expectToThrow(() => importModule(filePath), DiscoveryError);
      await expectToThrow(() => importModule(filePath), DiscoveryError);
      await expectToThrow(() => importModule(filePath), DiscoveryError);
    });
  });

  test("a module that imports cleanly is unaffected and is not cached as failed", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "fine.ts");
      await writeFile(filePath, `export const value = "ok";\n`);

      const a = await importModule(filePath);
      const b = await importModule(filePath);
      expect(a.value).toBe("ok");
      expect(b.value).toBe("ok");
    });
  });

  test("resetImportFailures forgets the record, and does not make the module re-evaluate", async () => {
    await withTestDir(async (testDir) => {
      const filePath = join(testDir, "throws-reset.ts");
      await writeFile(filePath, `const o = undefined as unknown as { k: string };\nexport const value = o.k;\n`);

      const first = await expectToThrow(() => importModule(filePath), DiscoveryError);
      resetImportFailures();

      // Under Node the registry still holds the failed record and throws
      // again; under vitest the module is served from its cache. Either way
      // the escape hatch only clears chant's memory, which is what its doc
      // says — so this asserts the clearing, not a re-evaluation.
      let replayedSameObject = false;
      try {
        await importModule(filePath);
      } catch (err) {
        replayedSameObject = err === first;
      }
      expect(replayedSameObject).toBe(false);
    });
  });
});

describe("discover() reports the same errors on a second pass (#2368)", () => {
  /**
   * The reproduction from the issue, over the corpus entry that exposed it.
   *
   * It has to be a file inside the project: vitest transforms and caches those,
   * and it is that cache which forgets an evaluation failure. A module written
   * to a temp directory outside the runner's root is imported by Node natively
   * and already behaves correctly, so a fixture built with `withTestDir` would
   * pass with or without the fix and prove nothing.
   *
   * `examples/fold-adversarial/src/nullish-property-read.ts` folds to a refusal
   * and then throws a TypeError when the run path imports it (#2328). Before
   * the failure map: `discover #1 errors=1`, `discover #2 errors=0`.
   */
  const ADVERSARIAL = resolve(import.meta.dirname, "../../../../examples/fold-adversarial/src");

  test("the corpus entry with a throwing file reports it on every pass", async () => {
    const first = await discover(ADVERSARIAL);
    const second = await discover(ADVERSARIAL);
    const third = await discover(ADVERSARIAL);

    expect(first.errors.length).toBeGreaterThan(0);
    expect(second.errors.length).toBe(first.errors.length);
    expect(third.errors.length).toBe(first.errors.length);

    const named = (r: { errors: unknown[] }): boolean =>
      (r.errors[0] as { file?: string }).file?.endsWith("nullish-property-read.ts") === true;
    expect(named(first) && named(second) && named(third)).toBe(true);
  });
});
