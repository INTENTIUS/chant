import { describe, test, expect } from "bun:test";
import { generateBarrelTypes, syncProject } from "./sync";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectScan } from "./scan";

describe("generateBarrelTypes", () => {
  test("generates valid .d.ts with import and typed $", () => {
    const scan: ProjectScan = {
      barrelPath: "/project/_.ts",
      lexiconPackage: "@intentius/chant-lexicon-testdom",
      exports: [
        { name: "dataBucket", file: "./data-bucket", className: "Bucket" },
        { name: "logsBucket", file: "./logs-bucket", className: "Bucket" },
        { name: "functionRole", file: "./iam", className: "Role" },
      ],
    };

    const result = generateBarrelTypes(scan);
    expect(result).toContain(
      'import type * as _lexicon from "@intentius/chant-lexicon-testdom";',
    );
    expect(result).toContain("dataBucket: _lexicon.Bucket;");
    expect(result).toContain("logsBucket: _lexicon.Bucket;");
    expect(result).toContain("functionRole: _lexicon.Role;");
    expect(result).toContain("export declare const $: typeof _barrel;");
  });

  test("uses unknown for unresolvable types", () => {
    const scan: ProjectScan = {
      barrelPath: "/project/_.ts",
      lexiconPackage: "@intentius/chant-lexicon-testdom",
      exports: [
        { name: "dataBucket", file: "./data-bucket", className: "Bucket" },
        { name: "greeting", file: "./utils", className: "" },
      ],
    };

    const result = generateBarrelTypes(scan);
    expect(result).toContain("dataBucket: _lexicon.Bucket;");
    expect(result).toContain("greeting: unknown;");
  });

  test("handles scan with no lexicon package", () => {
    const scan: ProjectScan = {
      barrelPath: "/project/_.ts",
      lexiconPackage: "",
      exports: [
        { name: "bucket", file: "./storage", className: "Bucket" },
      ],
    };

    const result = generateBarrelTypes(scan);
    expect(result).not.toContain("import type");
    expect(result).toContain("bucket: Bucket;");
  });
});

describe("syncProject", () => {
  test("writes _.d.ts to directory", async () => {
    await withTestDir(async (dir) => {
      await writeFile(
        join(dir, "_.ts"),
        `export * from "@intentius/chant-lexicon-testdom";\n`,
      );
      await writeFile(
        join(dir, "storage.ts"),
        [
          `import * as td from "@intentius/chant-lexicon-testdom";`,
          `export const dataBucket = new td.Bucket({});`,
          `export const logsBucket = new td.Bucket({});`,
        ].join("\n"),
      );

      syncProject(dir);

      const dtsContent = await readFile(join(dir, "_.d.ts"), "utf-8");
      expect(dtsContent).toContain(
        'import type * as _lexicon from "@intentius/chant-lexicon-testdom";',
      );
      expect(dtsContent).toContain("dataBucket: _lexicon.Bucket;");
      expect(dtsContent).toContain("logsBucket: _lexicon.Bucket;");
      expect(dtsContent).toContain("export declare const $: typeof _barrel;");
    });
  });
});
