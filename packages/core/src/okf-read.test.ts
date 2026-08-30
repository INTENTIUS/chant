import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadOkfBundle, bindConcepts } from "./okf-read";
import { buildOkfBundle } from "./okf";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

const TEST_DIR = join(import.meta.dirname, "__test_okf_read__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(TEST_DIR, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("loadOkfBundle", () => {
  test("a missing directory yields an empty bundle, not an error", async () => {
    const bundle = await loadOkfBundle(join(TEST_DIR, "does-not-exist"));
    expect(bundle.concepts).toEqual([]);
  });

  test("skips index.md and log.md, at any depth", async () => {
    write("index.md", "---\nokf_version: '0.2'\n---\n");
    write("log.md", "---\ntype: log\n---\nsome log\n");
    write("nested/log.md", "---\ntype: log\n---\nnested log\n");
    write("decisions/keep.md", "---\ntype: decision\ntitle: Keep me\n---\nbody\n");

    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts.map((c) => c.path)).toEqual(["decisions/keep.md"]);
  });

  test("passes through unknown type values and extra frontmatter keys", async () => {
    write("weird.md", "---\ntype: some-unknown-type\ncustom_field: hello\n---\nbody text\n");

    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts).toHaveLength(1);
    const [concept] = bundle.concepts;
    expect(concept.type).toBe("some-unknown-type");
    expect(concept.frontmatter.custom_field).toBe("hello");
    expect(concept.body).toContain("body text");
  });

  test("skips a file with unparseable frontmatter, warns, and does not affect other files", async () => {
    write("broken.md", "not frontmatter at all\n");
    write("fine.md", "---\ntype: decision\ntitle: Fine\n---\nbody\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const bundle = await loadOkfBundle(TEST_DIR);

    expect(bundle.concepts.map((c) => c.path)).toEqual(["fine.md"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("never rejects the bundle for a malformed file — an empty frontmatter block loads with an empty type", async () => {
    write("empty-front.md", "---\n---\nbody\n");
    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts).toHaveLength(1);
    expect(bundle.concepts[0].type).toBe("");
    expect(bundle.concepts[0].binds).toEqual([]);
  });

  test("binds accepts a single name", async () => {
    write("single.md", "---\ntype: decision\nbinds: myBucket\n---\nbody\n");
    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts[0].binds).toEqual(["myBucket"]);
  });

  test("binds accepts a list", async () => {
    write("multi.md", "---\ntype: decision\nbinds:\n  - myBucket\n  - vpc\n---\nbody\n");
    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts[0].binds).toEqual(["myBucket", "vpc"]);
  });

  test("a concept without binds loads as unbound and is legitimate", async () => {
    write("orphan.md", "---\ntype: runbook\ntitle: Incident response\n---\nbody\n");
    const bundle = await loadOkfBundle(TEST_DIR);
    expect(bundle.concepts[0].binds).toEqual([]);
  });
});

describe("bindConcepts", () => {
  test("returns bound concepts per entity name plus unresolved bindings", async () => {
    write("bound.md", "---\ntype: decision\ntitle: Bound\nbinds: myBucket\n---\nbody\n");
    write("multi.md", "---\ntype: decision\ntitle: Spans two\nbinds:\n  - myBucket\n  - vpc\n---\nbody\n");
    write("stale.md", "---\ntype: decision\ntitle: Stale\nbinds: ghost\n---\nbody\n");
    write("orphan.md", "---\ntype: runbook\ntitle: Orphan\n---\nbody\n");

    const bundle = await loadOkfBundle(TEST_DIR);
    const entities = new Map<string, Declarable>([
      ["myBucket", decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" })],
      ["vpc", decl({ lexicon: "gcp", entityType: "Vpc" })],
    ]);

    const { bound, unresolved } = bindConcepts(bundle, entities);

    expect(bound.get("myBucket")?.map((c) => c.title)).toEqual(["Bound", "Spans two"]);
    expect(bound.get("vpc")?.map((c) => c.title)).toEqual(["Spans two"]);
    expect(bound.has("ghost")).toBe(false);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].name).toBe("ghost");
    expect(unresolved[0].concept.title).toBe("Stale");
  });

  test("an entity with no bound concepts is absent from the map, never present with []", async () => {
    const bundle = await loadOkfBundle(join(TEST_DIR, "empty"));
    const entities = new Map<string, Declarable>([["vpc", decl({ lexicon: "gcp", entityType: "Vpc" })]]);
    const { bound, unresolved } = bindConcepts(bundle, entities);
    expect(bound.size).toBe(0);
    expect(unresolved).toEqual([]);
  });
});

describe("round trip with buildOkfBundle (#1058) — the emitter never writes binds", () => {
  test("reading back an emitted bundle yields zero bindings", async () => {
    const bucket = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const entities = new Map<string, Declarable>([
      ["myBucket", bucket],
      ["vpc", vpc],
    ]);
    const dependencies = new Map([["myBucket", new Set(["vpc"])]]);

    for (const file of buildOkfBundle({ entities, dependencies })) {
      write(file.path, file.content);
    }

    const bundle = await loadOkfBundle(TEST_DIR);
    // index.md is reserved and skipped; the two entity concepts load.
    expect(bundle.concepts.map((c) => c.path).sort()).toEqual(["aws/myBucket.md", "gcp/vpc.md"]);
    expect(bundle.concepts.every((c) => c.binds.length === 0)).toBe(true);

    const { bound, unresolved } = bindConcepts(bundle, entities);
    expect(bound.size).toBe(0);
    expect(unresolved).toEqual([]);
  });
});
