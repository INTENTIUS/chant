import { afterEach, describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync as readFile, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBlobToPath } from "./git";
import {
  observationBaselineStoreConfig,
  readObservationBaseline,
  saveObservationBaseline,
  OBSERVATION_BASELINE_FILE,
  acceptDeviations,
  acceptedDeviation,
  baselineForLexicon,
  countAccepted,
  emptyBaseline,
  isObservationBaseline,
  parseBaseline,
  serializeBaseline,
} from "./observation-baseline";

describe("the baseline document", () => {
  test("round-trips through serialize/parse", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "Assets", type: "AWS::S3::Bucket", path: "Tags[0].Value", value: "platform", note: "org policy" },
    ], { now: "2026-07-27T00:00:00.000Z" });
    const parsed = parseBaseline(serializeBaseline(b));
    expect(parsed).toEqual(b);
  });

  test("serializes with sorted keys and a trailing newline, so the commit diff reads cleanly", () => {
    const json = serializeBaseline(emptyBaseline("prod"));
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({ baseline: "v1", environment: "prod", lexicons: {} });
  });

  test("refuses to read anything that is not a versioned baseline", () => {
    expect(parseBaseline(null)).toBeNull();
    expect(parseBaseline("")).toBeNull();
    expect(parseBaseline("{ not json")).toBeNull();
    expect(parseBaseline('{"baseline":"v2","lexicons":{}}')).toBeNull();
    expect(parseBaseline('{"lexicons":{}}')).toBeNull();
    expect(isObservationBaseline({ baseline: "v1", lexicons: {} })).toBe(true);
  });
});

describe("acceptDeviations", () => {
  const now = "2026-07-27T00:00:00.000Z";

  test("records a deviation bound to the value that was accepted", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "Role", type: "AWS::IAM::Role", path: "MaxSessionDuration", value: 7200 },
    ], { now });
    expect(baselineForLexicon(b, "aws")).toEqual({
      Role: {
        type: "AWS::IAM::Role",
        accepted: [{ path: "MaxSessionDuration", value: 7200, recordedAt: now }],
      },
    });
    expect(b.updated).toBe(now);
  });

  test("does not mutate the input", () => {
    const before = emptyBaseline("prod");
    acceptDeviations(before, "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    expect(before.lexicons).toEqual({});
  });

  test("re-accepting the same path replaces the entry rather than appending a second", () => {
    let b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    b = acceptDeviations(b, "aws", [{ entity: "R", path: "A", value: 2 }], { now });
    expect(baselineForLexicon(b, "aws").R.accepted).toEqual([{ path: "A", value: 2, recordedAt: now }]);
  });

  test("keeps deviations from other entities and other lexicons", () => {
    let b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R1", path: "A", value: 1 }], { now });
    b = acceptDeviations(b, "aws", [{ entity: "R2", path: "B", value: 2 }], { now });
    b = acceptDeviations(b, "k8s", [{ entity: "D", path: "spec.replicas", value: 3 }], { now });
    expect(Object.keys(baselineForLexicon(b, "aws")).sort()).toEqual(["R1", "R2"]);
    expect(countAccepted(b)).toBe(3);
  });

  test("accepted paths sort, so the committed file is stable across runs", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "R", path: "Z", value: 1 },
      { entity: "R", path: "A", value: 2 },
    ], { now });
    expect(baselineForLexicon(b, "aws").R.accepted.map((a) => a.path)).toEqual(["A", "Z"]);
  });

  test("an empty accept list is a no-op", () => {
    const b = emptyBaseline("prod");
    expect(acceptDeviations(b, "aws", [])).toBe(b);
  });

  test("lookup is by entity and path", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    const lex = baselineForLexicon(b, "aws");
    expect(acceptedDeviation(lex, "R", "A")?.value).toBe(1);
    expect(acceptedDeviation(lex, "R", "B")).toBeUndefined();
    expect(acceptedDeviation(lex, "Other", "A")).toBeUndefined();
  });

  test("a missing baseline reads as nothing accepted", () => {
    expect(baselineForLexicon(null, "aws")).toEqual({});
    expect(countAccepted(null)).toBe(0);
  });
});

describe("acceptDeviations refuses effect receipts (#1833)", () => {
  const now = "2026-08-24T00:00:00.000Z";

  test("refuses a deviation whose type is the core receipt entityType", () => {
    expect(() =>
      acceptDeviations(emptyBaseline("prod"), "chant", [
        { entity: "seededReceipt", type: "Chant::EffectReceipt", path: "value", value: "gone" },
      ], { now }),
    ).toThrow(/effect receipt "seededReceipt"/);
  });

  test("refuses a deviation on an entity the caller recognized as a receipt (materialized row)", () => {
    expect(() =>
      acceptDeviations(emptyBaseline("prod"), "aws", [
        { entity: "migratedReceipt", type: "AWS::SSM::Parameter", path: "Value", value: "stale" },
      ], { now, receipts: new Set(["migratedReceipt"]) }),
    ).toThrow(/effect receipt "migratedReceipt"/);
  });

  test("the refusal names the receipt and the effect step as sole writer, and records nothing", () => {
    const before = emptyBaseline("prod");
    let error: Error | undefined;
    try {
      acceptDeviations(before, "aws", [
        { entity: "Role", type: "AWS::IAM::Role", path: "MaxSessionDuration", value: 7200 },
        { entity: "migratedReceipt", type: "AWS::SSM::Parameter", path: "Value", value: "stale" },
      ], { now, receipts: new Set(["migratedReceipt"]) });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('effect receipt "migratedReceipt"');
    expect(error!.message).toContain("only writer");
    expect(error!.message).toContain("defuse the effect");
    // The whole acceptance aborts — the non-receipt row was not recorded either.
    expect(before.lexicons).toEqual({});
  });

  test("passes: non-receipt deviations accept as before, receipts set present", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "Role", type: "AWS::IAM::Role", path: "MaxSessionDuration", value: 7200 },
    ], { now, receipts: new Set(["migratedReceipt"]) });
    expect(baselineForLexicon(b, "aws").Role.accepted).toHaveLength(1);
  });
});

// ── Where it lives (#4519) ──────────────────────────────────────────────────

describe("the baseline's home", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "baseline-home-")));
    dirs.push(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@chant.dev"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
    return dir;
  };
  const accepted = () =>
    acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "Assets", path: "Tags[0].Value", value: "platform" }], { now: "2026-10-26T00:00:00.000Z" });

  test("the default is a file under .chant/observation-baseline/, written for review and never on the orphan branch", async () => {
    const cwd = repo();
    const saved = await saveObservationBaseline(accepted(), { cwd, config: {} });
    expect(saved).toMatchObject({ where: join(".chant", "observation-baseline", "prod.json"), published: "file" });
    const file = join(cwd, ".chant", "observation-baseline", "prod.json");
    expect(parseBaseline(readFile(file, "utf8"))).toEqual(accepted());
    expect(await readObservationBaseline("prod", { cwd, config: {} })).toEqual(accepted());
    expect(() => execFileSync("git", ["rev-parse", "--verify", "-q", "refs/heads/chant/lifecycle"], { cwd })).toThrow();
  });

  test("a baseline written on chant/lifecycle before #4519 is still read when no file holds one", async () => {
    const cwd = repo();
    await writeBlobToPath("prod", OBSERVATION_BASELINE_FILE, serializeBaseline(accepted()), "legacy", { cwd });
    expect(await readObservationBaseline("prod", { cwd, config: {} })).toEqual(accepted());
  });

  test("none keeps nothing and reads nothing", async () => {
    const cwd = repo();
    const store = { store: "none" as const };
    expect((await saveObservationBaseline(accepted(), { cwd, store })).published).toBe("none");
    expect(existsSync(join(cwd, ".chant"))).toBe(false);
    expect(await readObservationBaseline("prod", { cwd, store })).toBeNull();
  });

  test("git-ref writes refs/chant/observation-baseline and reads it back", async () => {
    const cwd = repo();
    const store = { store: "git-ref" as const };
    const saved = await saveObservationBaseline(accepted(), { cwd, store });
    expect(saved.where).toBe("refs/chant/observation-baseline:prod.json");
    expect(saved.published).toBe("local");
    expect(await readObservationBaseline("prod", { cwd, store })).toEqual(accepted());
  });

  test("the environment overrides chant.config.ts", () => {
    expect(observationBaselineStoreConfig(undefined, {})).toEqual({ store: "file" });
    expect(observationBaselineStoreConfig({ store: "git-ref" }, { CHANT_OBSERVATION_BASELINE_STORE: "none" })).toEqual({ store: "none" });
    expect(() => observationBaselineStoreConfig({ store: "branch" }, {})).toThrow(/not one of/);
  });
});
