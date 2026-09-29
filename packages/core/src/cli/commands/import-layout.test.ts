import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin } from "../../lexicon";
import type { GeneratedFile, TypeScriptGenerator } from "../../import/generator";
import type { TemplateIR } from "../../import/parser";
import { generateOrganizedFiles, importCommand } from "./import";

// A generator that writes one module per resource plus a barrel, the shape
// the otel, prometheus and grafana importers want (#2964).
function perResourceFiles(ir: TemplateIR): GeneratedFile[] {
  return [
    ...ir.resources.map((r) => ({
      path: `${r.logicalId}.ts`,
      content: `export const ${r.logicalId} = ${JSON.stringify(r.properties)};\n`,
    })),
    { path: "index.ts", content: ir.resources.map((r) => `export * from "./${r.logicalId}";`).join("\n") + "\n" },
  ];
}

const placing: TypeScriptGenerator = { ownsLayout: true, generate: perResourceFiles };
const defaultLayout: TypeScriptGenerator = { generate: perResourceFiles };

// Five resources: over core's three-resource threshold, across two categories.
const fiveIR: TemplateIR = {
  resources: [
    { logicalId: "receiver", type: "Fake::Receiver", properties: { port: 4317 } },
    { logicalId: "processor", type: "Fake::Processor", properties: {} },
    { logicalId: "exporter", type: "Fake::Exporter", properties: {} },
    { logicalId: "pipeline", type: "Fake::Pipeline", properties: {} },
    { logicalId: "bucket", type: "Fake::Bucket", properties: {} },
  ],
  parameters: [],
};

describe("generateOrganizedFiles (#2964)", () => {
  test("a generator with ownsLayout gets one call and its files are written as returned", () => {
    const generate = vi.fn(perResourceFiles);
    const { files, warnings } = generateOrganizedFiles(fiveIR, { ownsLayout: true, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(fiveIR);
    expect(files).toEqual(perResourceFiles(fiveIR));
    expect(warnings).toEqual([]);
  });

  test("ownsLayout writes nothing extra when the generator returns nothing", () => {
    const { files } = generateOrganizedFiles(fiveIR, { ownsLayout: true, generate: () => [] });
    expect(files).toEqual([]);
  });

  test("the default layout splits by category and names every file it drops", () => {
    const { files, warnings } = generateOrganizedFiles(fiveIR, defaultLayout);
    expect(files.map((f) => f.path)).toEqual(["other.ts", "storage.ts", "index.ts"]);
    expect(warnings).toEqual([
      "The generator returned 5 files for other.ts; only the first was kept, and processor.ts, exporter.ts, " +
        "pipeline.ts, index.ts were not written. A generator that places its own files sets ownsLayout (#2964).",
      "The generator returned 2 files for storage.ts; only the first was kept, and index.ts was not written. " +
        "A generator that places its own files sets ownsLayout (#2964).",
    ]);
  });

  test("the default layout skips a category the generator returns nothing for, with a warning", () => {
    const { files, warnings } = generateOrganizedFiles(fiveIR, { generate: () => [] });
    expect(files).toEqual([]);
    expect(warnings).toEqual([
      "The generator returned no file for other.ts; it was not written.",
      "The generator returned no file for storage.ts; it was not written.",
    ]);
  });

  test("the default layout stays silent for a generator that returns one file per call", () => {
    const oneFile: TypeScriptGenerator = { generate: (ir) => [perResourceFiles(ir)[0]] };
    const { files, warnings } = generateOrganizedFiles(fiveIR, oneFile);
    expect(files.map((f) => f.path)).toEqual(["other.ts", "storage.ts", "index.ts"]);
    expect(warnings).toEqual([]);
  });

  test("up to three resources are one call either way", () => {
    const small: TemplateIR = { resources: fiveIR.resources.slice(0, 3), parameters: [] };
    expect(generateOrganizedFiles(small, defaultLayout)).toEqual({ files: perResourceFiles(small), warnings: [] });
  });
});

// Through the CLI: a fake lexicon whose parser yields fiveIR.
const { fakes } = vi.hoisted(() => ({ fakes: {} as Record<string, LexiconPlugin> }));

vi.mock("../plugins", () => ({
  resolveProjectLexicons: async () => Object.keys(fakes),
  loadPlugins: async (names: string[]) => names.map((n) => fakes[n]),
  loadPlugin: async (n: string) => fakes[n],
  listInstalledLexicons: () => [],
}));

function fakeLexicon(name: string, generator: TypeScriptGenerator): LexiconPlugin {
  return {
    name,
    detectTemplate: (data: unknown) => typeof data === "object" && data !== null && "fakeMarker" in data,
    templateParser: () => ({ parse: () => fiveIR }),
    templateGenerator: () => generator,
  } as unknown as LexiconPlugin;
}

describe("chant import writes a placing generator's files (#2964)", () => {
  let testDir: string;
  let templatePath: string;
  let outputDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-import-layout-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    templatePath = join(testDir, "config.json");
    outputDir = join(testDir, "out");
    await writeFile(templatePath, JSON.stringify({ fakeMarker: true }));
    fakes.placing = fakeLexicon("placing", placing);
    fakes.splitting = fakeLexicon("splitting", defaultLayout);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    for (const k of Object.keys(fakes)) delete fakes[k];
  });

  test("ownsLayout: every file the generator returns is written", async () => {
    const result = await importCommand({ templatePath, output: outputDir, lexicon: "placing" });
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.generatedFiles).toEqual(perResourceFiles(fiveIR).map((f) => f.path));
    expect(await readFile(join(outputDir, "pipeline.ts"), "utf-8")).toBe("export const pipeline = {};\n");
    expect(existsSync(join(outputDir, "other.ts"))).toBe(false);
  });

  test("default layout: the dropped files are named in the import warnings", async () => {
    const result = await importCommand({ templatePath, output: outputDir, lexicon: "splitting" });
    expect(result.success).toBe(true);
    expect(result.generatedFiles).toEqual(["other.ts", "storage.ts", "index.ts"]);
    expect(result.warnings.some((w) => w.includes("processor.ts, exporter.ts, pipeline.ts, index.ts were not written"))).toBe(
      true,
    );
  });
});
