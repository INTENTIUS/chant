import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { liveImportFromPlugins } from "./import";
import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin, ExportedTemplate, ResourceSelector } from "../../lexicon";
import type { TypeScriptGenerator } from "../../import/generator";
import type { TemplateIR } from "../../import/parser";

const generator: TypeScriptGenerator = {
  generate(ir: TemplateIR) {
    return [
      {
        path: "main.ts",
        content: ir.resources
          .map((r) => `export const ${r.logicalId} = ${JSON.stringify(r.properties)};`)
          .join("\n"),
      },
    ];
  },
};

function fakeExporter(name: string, ir: ExportedTemplate): LexiconPlugin {
  return {
    name,
    serializer: {} as never,
    generate: async () => {},
    validate: async () => {},
    coverage: async () => {},
    package: async () => {},
    templateGenerator: () => generator,
    async exportResources(opts: { selector?: ResourceSelector }): Promise<ExportedTemplate> {
      if (!opts.selector) return ir;
      return {
        ...ir,
        resources: ir.resources.filter(
          (r) =>
            (opts.selector!.type === undefined || r.type === opts.selector!.type) &&
            (opts.selector!.name === undefined || r.logicalId === opts.selector!.name),
        ),
      };
    },
  };
}

const sampleIR: ExportedTemplate = {
  resources: [
    { logicalId: "bucket", type: "Fake::Bucket", properties: { versioning: true } },
    { logicalId: "queue", type: "Fake::Queue", properties: { fifo: false } },
  ],
  parameters: [],
};

describe("liveImportFromPlugins (#114)", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `chant-live-import-${Date.now()}-${Math.random()}`);
    await mkdir(outputDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  test("regenerates resources from a live exporter", async () => {
    const result = await liveImportFromPlugins([fakeExporter("fake", sampleIR)], {
      environment: "prod",
      output: outputDir,
      force: true,
    });
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("fake");
    const content = await readFile(join(outputDir, result.generatedFiles[0]), "utf-8");
    expect(content).toContain("bucket");
    expect(content).toContain("queue");
  });

  test("--name selector narrows the regenerated source", async () => {
    const result = await liveImportFromPlugins([fakeExporter("fake", sampleIR)], {
      environment: "prod",
      output: outputDir,
      force: true,
      selector: { name: "queue" },
    });
    const content = await readFile(join(outputDir, result.generatedFiles[0]), "utf-8");
    expect(content).toContain("queue");
    expect(content).not.toContain("bucket");
  });

  test("errors when no lexicon supports live export", async () => {
    const nonExporter: LexiconPlugin = {
      name: "noexport",
      serializer: {} as never,
      generate: async () => {},
      validate: async () => {},
      coverage: async () => {},
      package: async () => {},
    };
    const result = await liveImportFromPlugins([nonExporter], {
      environment: "prod",
      output: outputDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("live export");
  });

  test("--lexicon narrows to the named exporter", async () => {
    const result = await liveImportFromPlugins(
      [fakeExporter("a", sampleIR), fakeExporter("b", sampleIR)],
      { environment: "prod", output: outputDir, force: true, lexicon: "b" },
    );
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("b");
  });

  test("errors when the environment exports nothing", async () => {
    const empty = fakeExporter("fake", { resources: [], parameters: [] });
    const result = await liveImportFromPlugins([empty], {
      environment: "prod",
      output: outputDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No resources exported");
  });
});
