import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { liveImportFromPlugins } from "./import";
import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin, ExportedTemplate, ResourceSelector } from "../../lexicon";
import type { TypeScriptGenerator } from "../../import/generator";
import type { TemplateIR, ParseContext } from "../../import/parser";
import type { EmbeddedContentImporter } from "../../import/embedded";

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

  // #932 — a multi-stack reconcile imports each stack from its own live
  // CloudFormation stack; the `stack` option must reach `exportResources` so
  // the right stack is queried (not one env-named stack for all of them).
  test("threads the stack option through to exportResources", async () => {
    let seenStack: string | undefined = "unset";
    const capturing: LexiconPlugin = {
      name: "aws",
      serializer: {} as never,
      generate: async () => {},
      validate: async () => {},
      coverage: async () => {},
      package: async () => {},
      templateGenerator: () => generator,
      async exportResources(opts: { stack?: string }): Promise<ExportedTemplate> {
        seenStack = opts.stack;
        return sampleIR;
      },
    };
    const result = await liveImportFromPlugins([capturing], {
      environment: "prod",
      stack: "loom-backend",
      output: outputDir,
      force: true,
    });
    expect(result.success).toBe(true);
    expect(seenStack).toBe("loom-backend");
  });

  // #2995: an export with `reparse` goes through the same embedded-content
  // delegation as file import.
  describe("embedded content (#2995)", () => {
    const configText = "service:\n  pipelines: {}\n";

    function hostExporter(): LexiconPlugin {
      const parse = (context?: ParseContext): TemplateIR => {
        const ref = context?.embedded?.resolve({
          host: "fake",
          hostType: "Fake::ConfigMap",
          location: "ConfigMap cfg data[\"config.yaml\"]",
          directory: "cfg",
          text: configText,
          expectedOwner: { lexicon: "owner", what: "an owner config" },
        });
        return {
          resources: [{ logicalId: "cfg", type: "Fake::ConfigMap", properties: { data: ref ?? configText } }],
          parameters: [],
        };
      };
      return {
        ...fakeExporter("fake", { resources: [], parameters: [] }),
        async exportResources(): Promise<ExportedTemplate> {
          return { ...parse(), reparse: (context) => parse(context) };
        },
      };
    }

    const importer: EmbeddedContentImporter = {
      what: "an owner config",
      matches: (c) => typeof c.document === "object" && c.document !== null && "service" in c.document,
      import: () => ({
        files: [{ path: "config.ts", content: "export const config = {};\n" }],
        value: { bindings: [{ from: "config.ts", name: "config" }], shape: "single" },
      }),
    };
    const owner: LexiconPlugin = {
      name: "owner",
      serializer: {} as never,
      generate: async () => {},
      validate: async () => {},
      coverage: async () => {},
      package: async () => {},
      embeddedImporters: () => [importer],
    };

    test("a loaded owner imports the content and its modules are written beside the host's", async () => {
      const result = await liveImportFromPlugins([hostExporter(), owner], { environment: "prod", output: outputDir, force: true });
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.generatedFiles).toEqual(["main.ts", "cfg/config.ts"]);
      const main = await readFile(join(outputDir, "main.ts"), "utf-8");
      expect(main).toContain('"$embedded"');
      expect(main).toContain('"from":"cfg/config.ts"');
      expect(await readFile(join(outputDir, "cfg/config.ts"), "utf-8")).toContain("export const config");
    });

    test("with no owner the content is kept as read, with a warning", async () => {
      const result = await liveImportFromPlugins([hostExporter()], { environment: "prod", output: outputDir, force: true });
      expect(result.success).toBe(true);
      expect(result.generatedFiles).toEqual(["main.ts"]);
      expect(result.warnings.join("\n")).toContain("no installed lexicon imports it");
      const main = await readFile(join(outputDir, "main.ts"), "utf-8");
      expect(main).toContain(JSON.stringify(configText));
    });
  });
});
