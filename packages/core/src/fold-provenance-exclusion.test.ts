/**
 * chant #2161 — the fold provenance record provably never reaches the
 * apply-bound output.
 *
 * Appliers consume the serialized build outputs, so the exclusion has to hold
 * at the serializer-input boundary, which is where `effect-receipt-exclusion.test.ts`
 * puts the same question for receipts. These tests drive a real fold build over
 * a composite fixture, spy on the serializer, and then drive the serialized
 * output through a mock applier.
 *
 * The provenance markers are proven present in `BuildResult.foldProvenance`
 * FIRST, so the string search below is known to be capable of firing before
 * anything asserts that it does not.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build";
import { walkValue } from "./serializer-walker";
import type { Serializer, SerializeContext } from "./serializer";
import type { Declarable } from "./declarable";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../..");
const compositePath = resolve(thisDir, "./composite");

const LEXICON = "@intentius/chant-lexicon-aws";
const LEXICON_NAME = "aws";

/** Every string that only appears if a provenance record leaked. */
const PROVENANCE_MARKERS = [
  "composite-parameter",
  "composite-literal",
  "chant.provenance",
  "foldProvenance",
  "WebService",
];

const COMPOSITES = `
  import { Bucket } from ${JSON.stringify(LEXICON)};
  import { Composite } from ${JSON.stringify(compositePath)};

  export const WebService = Composite((props) => {
    const bucket = new Bucket({
      BucketName: props.name,
      VersioningConfiguration: { Status: "Enabled" },
    });
    return { bucket };
  }, "WebService");
`;

const MAIN = `
  import { WebService } from "../composites";
  export const web = WebService({ name: "data" });
`;

/** Renders every entity's real props, the way a lexicon serializer does. */
function renderDocument(entities: Map<string, Declarable>): string {
  const names = new Map<Declarable, string>();
  for (const [name, entity] of entities) names.set(entity, name);
  const resources: Record<string, unknown> = {};
  for (const [name, entity] of [...entities].sort(([a], [b]) => a.localeCompare(b))) {
    resources[name] = {
      Type: entity.entityType,
      Properties: walkValue((entity as unknown as { props: unknown }).props, names, {
        attrRef: (logicalName, attribute) => ({ GetAtt: [logicalName, attribute] }),
        resourceRef: (logicalName) => ({ Ref: logicalName }),
        propertyDeclarable: (e, walk) => walk((e as unknown as { props: unknown }).props),
      }),
    };
  }
  return JSON.stringify({ Resources: resources }, null, 2);
}

let seq = 0;

describe("fold provenance apply write-exclusion (#2161)", () => {
  let testDir: string;
  let srcDir: string;

  beforeEach(async () => {
    const dir = join(repoRoot, ".cache", `chant-2161-excl-${process.pid}-${seq++}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    srcDir = join(testDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(testDir, "composites.ts"), COMPOSITES);
    await writeFile(join(srcDir, "main.ts"), MAIN);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("the serializer sees the entities and no provenance channel at all", async () => {
    const seen: Array<{ entities: string[]; contextKeys: string[]; enumerable: string[] }> = [];
    const serializer: Serializer = {
      name: LEXICON_NAME,
      rulePrefix: "TEST",
      serialize: (entities, _outputs, context?: SerializeContext) => {
        const enumerable: string[] = [];
        for (const entity of entities.values()) {
          enumerable.push(...Object.keys(entity));
          // The record must not be reachable as an enumerable own property of
          // `props` either, since that is what a serializer walks.
          enumerable.push(...Object.keys((entity as unknown as { props: object }).props ?? {}));
        }
        seen.push({
          entities: [...entities.keys()].sort(),
          contextKeys: Object.keys(context ?? {}).sort(),
          enumerable: [...new Set(enumerable)].sort(),
        });
        return renderDocument(entities);
      },
    };

    const result = await build(srcDir, [serializer], undefined, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    // The probe fires: the record exists, and it carries the markers.
    const record = JSON.stringify(result.foldProvenance);
    expect(record).toContain("composite-parameter");
    expect(record).toContain("composite-literal");
    expect(record).toContain("WebService");

    expect(seen).toHaveLength(1);
    expect(seen[0].entities).toEqual(["webBucket"]);
    // `SerializeContext` gained nothing. Provenance has no rendering, so unlike
    // an effect receipt it is not handed to a serializer at all.
    expect(seen[0].contextKeys).not.toContain("provenance");
    expect(seen[0].contextKeys).not.toContain("foldProvenance");
    expect(seen[0].contextKeys).not.toContain("pathOrigins");
    for (const key of seen[0].enumerable) {
      expect(PROVENANCE_MARKERS).not.toContain(key);
    }
  });

  test("no provenance marker survives into the built document", async () => {
    const serializer: Serializer = {
      name: LEXICON_NAME,
      rulePrefix: "TEST",
      serialize: (entities) => renderDocument(entities),
    };

    const result = await build(srcDir, [serializer], undefined, { fold: true, lexicons: [LEXICON_NAME] });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.foldProvenance)).toEqual(["webBucket"]);

    const document = result.outputs.get(LEXICON_NAME) as string;
    expect(document).toContain("webBucket"); // the probe can see the document at all
    for (const marker of PROVENANCE_MARKERS) {
      expect(document, `"${marker}" leaked into the apply-bound document`).not.toContain(marker);
    }
  });

  test("a mock apply driven from the build output writes the resource and nothing else", async () => {
    const serializer: Serializer = {
      name: LEXICON_NAME,
      rulePrefix: "TEST",
      serialize: (entities) => renderDocument(entities),
    };

    const result = await build(srcDir, [serializer], undefined, { fold: true, lexicons: [LEXICON_NAME] });
    const document = JSON.parse(result.outputs.get(LEXICON_NAME) as string) as {
      Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
    };

    // The generic applier: everything in the document is desired; owned live
    // resources absent from it are prune candidates.
    const live = ["webBucket", "orphan"];
    const desired = Object.keys(document.Resources);
    const writes: Array<{ name: string; fields: string[] }> = [];
    for (const name of desired) {
      writes.push({ name, fields: Object.keys(document.Resources[name].Properties).sort() });
    }
    const pruneCandidates = live.filter((name) => !desired.includes(name));

    expect(writes).toEqual([
      { name: "webBucket", fields: ["BucketName", "VersioningConfiguration"] },
    ]);
    expect(pruneCandidates).toEqual(["orphan"]);
  });
});
