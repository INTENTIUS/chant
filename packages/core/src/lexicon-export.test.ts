import { describe, expect, test } from "vitest";
import type {
  LexiconPlugin,
  ObservationLexicon,
  ExportedTemplate,
  ResourceSelector,
} from "./lexicon";
import type { TypeScriptGenerator } from "./import/generator";
import type { TemplateIR } from "./import/parser";

// A throwaway generator standing in for any lexicon's real templateGenerator().
const generator: TypeScriptGenerator = {
  generate(ir: TemplateIR) {
    return ir.resources.map((r) => ({
      path: `${r.logicalId}.ts`,
      content: `export const ${r.logicalId} = ${JSON.stringify(r.properties)};`,
    }));
  },
};

// A minimal lexicon that implements live export — the acceptance shape.
const exportingLexicon: Pick<LexiconPlugin, "name" | "exportResources"> = {
  name: "fake",
  async exportResources(opts: {
    environment: string;
    selector?: ResourceSelector;
    owned?: boolean;
  }): Promise<ExportedTemplate> {
    const selector = opts.selector;
    const all: ExportedTemplate = {
      resources: [
        { logicalId: "Bucket", type: "Fake::Bucket", properties: { versioning: true } },
        { logicalId: "Queue", type: "Fake::Queue", properties: { fifo: false } },
      ],
      parameters: [],
      metadata: { environment: opts.environment, owned: opts.owned ?? false },
    };
    if (!selector) return all;
    return {
      ...all,
      resources: all.resources.filter(
        (r) =>
          (selector.type === undefined || r.type === selector.type) &&
          (selector.name === undefined || r.logicalId === selector.name),
      ),
    };
  },
};

describe("exportResources contract (#113)", () => {
  test("an ExportedTemplate feeds templateGenerator() unchanged", async () => {
    const ir = await exportingLexicon.exportResources!({ environment: "prod" });
    // ExportedTemplate is structurally a TemplateIR — no adapter needed.
    const files = generator.generate(ir);
    expect(files.map((f) => f.path)).toEqual(["Bucket.ts", "Queue.ts"]);
    expect(files[0].content).toContain("versioning");
  });

  test("selector narrows the exported set", async () => {
    const ir = await exportingLexicon.exportResources!({
      environment: "prod",
      selector: { name: "Queue" },
    });
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].logicalId).toBe("Queue");
  });

  test("owned is accepted but inert (carried into metadata, no filtering yet)", async () => {
    const ir = await exportingLexicon.exportResources!({ environment: "prod", owned: true });
    expect(ir.metadata?.owned).toBe(true);
    expect(ir.resources).toHaveLength(2);
  });

  test("type separation: observation view cannot reach exportResources", () => {
    // A full plugin is assignable to the narrowed observation view…
    const full = exportingLexicon as unknown as LexiconPlugin;
    const observed: ObservationLexicon = full;
    // …but exportResources is not visible on it. Compile-time guarantee:
    // @ts-expect-error exportResources is omitted from ObservationLexicon
    void observed.exportResources;
    expect(typeof observed.name).toBe("string");
  });

  test("type separation: scrubbed metadata is not an ExportedTemplate", () => {
    // A ResourceMetadata-shaped object lacks resources/parameters, so it can
    // never be passed where an ExportedTemplate (full config) is expected.
    const scrubbed = { type: "Fake::Bucket", status: "OK" };
    // @ts-expect-error observation metadata is not a full-fidelity export
    const asExport: ExportedTemplate = scrubbed;
    expect(asExport).toBeDefined();
  });
});
