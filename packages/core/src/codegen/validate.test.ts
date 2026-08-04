import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateLexiconArtifacts } from "./validate";

function makeTempDir(): string {
  const dir = join(tmpdir(), `chant-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("validateLexiconArtifacts", () => {
  test("fails when lexicon JSON is missing", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Resource"],
      basePath: dir,
    });

    expect(result.success).toBe(false);
    const jsonCheck = result.checks.find((c) => c.name === "lexicon-json-exists");
    expect(jsonCheck?.ok).toBe(false);
    expect(jsonCheck?.error).toContain("lexicon-test.json not found");

    rmSync(dir, { recursive: true, force: true });
  });

  test("passes with valid artifacts and required names", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    const lexiconData = {
      Resource: {
        resourceType: "Test::Storage::Bucket",
        kind: "resource",
        lexicon: "test",
        attrs: { arn: "Arn" },
        createOnly: ["/properties/Name"],
        propertyConstraints: { Name: { minLength: 1 } },
        constraints: [{ name: "c1", type: "required_or" }],
      },
    };
    writeFileSync(join(genDir, "lexicon-test.json"), JSON.stringify(lexiconData));
    writeFileSync(join(genDir, "index.d.ts"), "export declare class Resource { readonly type: string; }");

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Resource"],
      basePath: dir,
      coverageThresholds: { minPropertyPct: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("detects missing required names", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    writeFileSync(join(genDir, "lexicon-test.json"), JSON.stringify({ Foo: { resourceType: "T", kind: "resource", lexicon: "t" } }));
    writeFileSync(join(genDir, "index.d.ts"), "export {};");

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Bar", "Baz"],
      basePath: dir,
    });

    const namesCheck = result.checks.find((c) => c.name === "required-names");
    expect(namesCheck?.ok).toBe(false);
    expect(namesCheck?.error).toContain("Bar");
    expect(namesCheck?.error).toContain("Baz");

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * chant #1473 — the release gate. `prepack` regenerates from an upstream that
 * moves, so what must match the reviewed baseline is the API that comes out,
 * not the archive that went in.
 */
describe("surface snapshot gate (#1473)", () => {
  const LEXICON = JSON.stringify({
    Bucket: { resourceType: "AWS::S3::Bucket", kind: "resource", lexicon: "aws" },
  });
  const DTS = "export declare class Bucket {}\n";

  function fixture(opts: { snapshot?: string } = {}): string {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });
    writeFileSync(join(genDir, "lexicon-test.json"), LEXICON);
    writeFileSync(join(genDir, "index.d.ts"), DTS);
    if (opts.snapshot !== undefined) writeFileSync(join(dir, "surface.snapshot.json"), opts.snapshot);
    return dir;
  }

  const run = (basePath: string, checkSurfaceSnapshot: boolean, armed = true) =>
    validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: [],
      basePath,
      checkSurfaceSnapshot,
      env: armed ? { CHANT_RELEASE_GATE: "1" } : {},
    });

  /** The snapshot a matching build would have produced. */
  async function matchingSnapshot(): Promise<string> {
    const { extractSurface, serializeSnapshot } = await import("./surface-snapshot");
    return serializeSnapshot(extractSurface(LEXICON, DTS));
  }

  test("passes when the generated API matches the snapshot", async () => {
    const result = await run(fixture({ snapshot: await matchingSnapshot() }), true);
    const check = result.checks.find((c) => c.name === "surface-matches-snapshot");
    expect(check?.ok).toBe(true);
  });

  test("fails when the generated API differs, and says how to accept it", async () => {
    const stale = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: { Queue: { kind: "resource", resourceType: "AWS::SQS::Queue", attrs: [], props: [] } },
    });
    const result = await run(fixture({ snapshot: stale }), true);
    const check = result.checks.find((c) => c.name === "surface-matches-snapshot");
    expect(check?.ok).toBe(false);
    expect(check?.error).toContain("--update-snapshot");
    expect(result.success).toBe(false);
  });

  test("is off unless the lexicon opts in", async () => {
    // k8s and azure are adrift from their own baselines (#1475); switching
    // this on globally would block their releases.
    const stale = JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", entries: {} });
    const result = await run(fixture({ snapshot: stale }), false);
    expect(result.checks.find((c) => c.name === "surface-matches-snapshot")).toBeUndefined();
  });

  test("does not run outside a release, even for a lexicon that opted in", async () => {
    // `validate` runs on every PR. Upstream can move the surface at any time,
    // so a hard check here would turn unrelated PRs red — the same trap the
    // spec pin fell into. Drift between releases is the upgrade job's business.
    const stale = JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", entries: {} });
    const result = await run(fixture({ snapshot: stale }), true, false);
    expect(result.checks.find((c) => c.name === "surface-matches-snapshot")).toBeUndefined();
    expect(result.success).toBe(true);
  });

  test("is skipped for a lexicon with no committed snapshot", async () => {
    // A new lexicon before its first baseline must still be able to build.
    const result = await run(fixture(), true);
    expect(result.checks.find((c) => c.name === "surface-matches-snapshot")).toBeUndefined();
  });

  test("an unreadable snapshot fails rather than passing silently", async () => {
    const result = await run(fixture({ snapshot: "{ not json" }), true);
    const check = result.checks.find((c) => c.name === "surface-matches-snapshot");
    expect(check?.ok).toBe(false);
  });
});
