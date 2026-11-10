/**
 * `chant dev dead-guards` (#4792) on fixture products: each feature-detect
 * shape the products use, found when the pin meets its floor and kept when it
 * does not, and the uses that are not checks left alone.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadGuardLine, findDeadGuards, guardsIn, insideTry, pinOf, scanSource } from "./dead-guards";
import { chantMeets, compareChantVersions, FLOOR_TABLE, floorVersion, type FloorRow } from "./floor-table";
import { NEXT_RELEASE } from "./release-floors";

const TABLE: FloorRow[] = [
  { name: "CI_CHECK_HOOK_FLOOR", version: "0.124.55", gates: "", file: "op/op-waves.ts", modules: ["@intentius/chant/op", "@intentius/chant/components/check-hooks"] },
  { name: "TEMPLATE_REQUEST_FLOOR", version: "0.124.58", gates: "", file: "template-request/template-request.ts", modules: ["@intentius/chant/template-request"] },
  { name: "CI_COMMIT_FLOOR", version: "0.124.71", gates: "", file: "ci-commit.ts", modules: ["@intentius/chant/ci-commit"] },
  { name: "CI_AGENT_FLOOR", version: "0.124.55", gates: "", file: "ci-agent.ts", modules: ["@intentius/chant/ci-agent", "@intentius/chant/ci-product"] },
  { name: "RELEASE_VERSION_FLOOR", version: "0.124.55", gates: "", file: "lifecycle/release-ledger.ts", modules: ["@intentius/chant/lifecycle/release-ledger"] },
  { name: "RELEASE_VERSION_FLOOR", version: "0.124.79", gates: "", file: "lifecycle/release-version.ts", modules: ["@intentius/chant/lifecycle/release-version"] },
  { name: "NEW_THING_FLOOR", version: "0.124.85", gates: "", file: "release-floors.ts", modules: ["@intentius/chant/new-thing"] },
];

/** A chant-next.ts in the shapes terragucci, plywood and sql-yodeler write. */
const CHANT_NEXT = `import { CI_AGENT_FLOOR, productPipelineJobs } from "@intentius/chant/ci-product";
import * as ci from "@intentius/chant/ci-agent";

export interface ChantCheckHooks {
  CI_CHECK_HOOK_FLOOR: string;
}

let hooks: Promise<ChantCheckHooks | undefined> | undefined;
export function chantCheckHooks() {
  hooks ??= (async () => {
    const specifier = "@intentius/chant/components/check-hooks";
    try {
      return (await import(specifier)) as ChantCheckHooks;
    } catch {
      return undefined;
    }
  })();
  return hooks;
}

export async function templates() {
  const m = (await import("@intentius/chant/template-request").catch(() => ({}))) as Record<string, unknown>;
  return typeof m.TEMPLATE_REQUEST_FLOOR === "string" ? m : undefined;
}

export async function commits() {
  const m = (await import("@intentius/chant/ci-commit")) as { CI_COMMIT_FLOOR?: string };
  return m.CI_COMMIT_FLOOR !== undefined;
}

// A comment naming m.CI_CHECK_HOOK_FLOOR is not a check.
export const AGENT = { CI_AGENT_FLOOR, jobs: productPipelineJobs, floor: ci.CI_AGENT_FLOOR };
export const NAMES = ["CI_CHECK_HOOK_FLOOR"];

export async function run() {
  try {
    return await import("@intentius/chant/op");
  } finally {
    // nothing caught
  }
}

export async function newThing(m: Record<string, unknown>) {
  return "NEW_THING_FLOOR" in m;
}

// chant-dead-guards: keep (a chant a user installs beside the product)
export const kept = (m: { CI_CHECK_HOOK_FLOOR?: string }) => m.CI_CHECK_HOOK_FLOOR;
export const keptToo = (m: { CI_CHECK_HOOK_FLOOR?: string }) => m.CI_CHECK_HOOK_FLOOR; // chant-dead-guards: keep

export const CHANT_CI_FLOOR = "0.124.50";
export const ledger = (m: { RELEASE_VERSION_FLOOR?: string }) => m.RELEASE_VERSION_FLOOR;
`;

function product(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dead-guards-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const pkg = (range: string) => JSON.stringify({ name: "p", dependencies: { "@intentius/chant": range } });

describe("guardsIn (#4792)", () => {
  it("finds each feature-detect shape and leaves uses, comments, try/finally and kept lines alone", () => {
    const found = guardsIn(CHANT_NEXT, TABLE).map((g) => `${g.line} ${g.kind} ${g.floor} ${g.version}`);
    expect(found).toEqual([
      "5 floor CI_CHECK_HOOK_FLOOR 0.124.55",
      "11 module @intentius/chant/components/check-hooks 0.124.55",
      "22 module @intentius/chant/template-request 0.124.58",
      "23 floor TEMPLATE_REQUEST_FLOOR 0.124.58",
      "27 floor CI_COMMIT_FLOOR 0.124.71",
      "28 floor CI_COMMIT_FLOOR 0.124.71",
      "44 floor NEW_THING_FLOOR 0.124.85",
      "51 product-floor CHANT_CI_FLOOR 0.124.50",
      "52 floor RELEASE_VERSION_FLOOR 0.124.79",
    ]);
  });

  it("blanks comments but keeps strings, template text and regular expressions apart", () => {
    const src = 'const a = "x // y"; // gone\nconst r = /"/; const t = `a ${b} c`; /* gone */';
    const { code, inString } = scanSource(src);
    expect(code).toContain('"x // y"');
    expect(code).not.toContain("gone");
    expect(inString[src.indexOf("x //")]).toBe(1);
    expect(inString[src.indexOf("b}")]).toBe(0);
    expect(inString[src.indexOf(" c`")]).toBe(1);
  });

  it("counts a try only when it has a catch", () => {
    const code = "try { await import(x) } catch { }\ntry { await import(y) } finally { }";
    expect(insideTry(code, code.indexOf("import(x)"))).toBe(true);
    expect(insideTry(code, code.indexOf("import(y)"))).toBe(false);
  });
});

describe("findDeadGuards (#4792)", () => {
  it("fails naming each guard the package.json pin meets, and skips tests, node_modules and builds", () => {
    const dir = product({
      "package.json": pkg("^0.124.60"),
      "src/chant-next.ts": CHANT_NEXT,
      "src/chant-next.test.ts": CHANT_NEXT,
      "node_modules/x/index.js": CHANT_NEXT,
      "dist/cli.js": CHANT_NEXT,
    });
    const r = findDeadGuards({ productDir: dir, table: TABLE });
    expect(r.ok).toBe(false);
    expect(r.files).toBe(1);
    expect(r.pins).toEqual([{ file: "package.json", pin: "0.124.60" }]);
    expect(r.dead.map((g) => `${g.file}:${g.line} ${g.floor}`)).toEqual([
      "src/chant-next.ts:5 CI_CHECK_HOOK_FLOOR",
      "src/chant-next.ts:11 @intentius/chant/components/check-hooks",
      "src/chant-next.ts:22 @intentius/chant/template-request",
      "src/chant-next.ts:23 TEMPLATE_REQUEST_FLOOR",
      "src/chant-next.ts:51 CHANT_CI_FLOOR",
    ]);
    expect(r.live.map((g) => `${g.line} ${g.floor}`)).toEqual(["27 CI_COMMIT_FLOOR", "28 CI_COMMIT_FLOOR", "44 NEW_THING_FLOOR", "52 RELEASE_VERSION_FLOOR"]);
    expect(deadGuardLine(r.dead[1])).toBe("src/chant-next.ts:11: loads @intentius/chant/components/check-hooks behind a catch, which chant 0.124.55 has; the pin 0.124.60 meets it");
  });

  it("passes when the pin meets none, and reads a nested package's own pin", () => {
    const dir = product({
      "package.json": pkg("0.124.54"),
      "src/a.ts": "export const f = (m: { CI_CHECK_HOOK_FLOOR?: string }) => m.CI_CHECK_HOOK_FLOOR;\n",
      "example/package.json": pkg("0.124.80"),
      "example/b.ts": "export const g = (m: { CI_CHECK_HOOK_FLOOR?: string }) => m.CI_CHECK_HOOK_FLOOR;\n",
      "docs/c.ts": "export const h = 1;\n",
    });
    const r = findDeadGuards({ productDir: dir, table: TABLE });
    expect(r.dead.map((g) => `${g.file}:${g.line} ${g.pin}`)).toEqual(["example/b.ts:1 0.124.80"]);
    expect(r.live.map((g) => `${g.file}:${g.line} ${g.pin}`)).toEqual(["src/a.ts:1 0.124.54"]);
    const none = findDeadGuards({ productDir: product({ "package.json": pkg("0.124.54"), "src/a.ts": "export const f = (m: { CI_CHECK_HOOK_FLOOR?: string }) => m.CI_CHECK_HOOK_FLOOR;\n" }), table: TABLE });
    expect(none.ok).toBe(true);
  });

  it("checks every file against --chant-version in place of the pins", () => {
    const dir = product({ "package.json": pkg("0.124.54"), "src/chant-next.ts": CHANT_NEXT });
    const r = findDeadGuards({ productDir: dir, table: TABLE, chant: "0.124.84" });
    expect(r.dead.map((g) => `${g.line} ${g.floor}`)).toEqual([
      "5 CI_CHECK_HOOK_FLOOR",
      "11 @intentius/chant/components/check-hooks",
      "22 @intentius/chant/template-request",
      "23 TEMPLATE_REQUEST_FLOOR",
      "27 CI_COMMIT_FLOOR",
      "28 CI_COMMIT_FLOOR",
      "51 CHANT_CI_FLOOR",
      "52 RELEASE_VERSION_FLOOR",
    ]);
    expect(r.live.map((g) => g.floor)).toEqual(["NEW_THING_FLOOR"]);
  });

  it("reads the lowest version a range admits, and none from a workspace or file range", () => {
    expect(pinOf("^0.124.78")).toBe("0.124.78");
    expect(pinOf(">=0.124.55 <0.125.0")).toBe("0.124.55");
    expect(pinOf("workspace:*")).toBeUndefined();
    expect(pinOf("file:../chant")).toBeUndefined();
  });
});

describe("the floor table (#4792)", () => {
  it("resolves a floor not yet released to the next release", () => {
    expect(floorVersion("FLOOR_TABLE_FLOOR")).toBe(NEXT_RELEASE);
    expect(chantMeets("0.124.84", "FLOOR_TABLE_FLOOR")).toBe(compareChantVersions("0.124.84", NEXT_RELEASE) >= 0);
  });

  it("answers a released floor, and the higher version of a name two files declare", () => {
    expect(floorVersion("CI_CHECK_HOOK_FLOOR")).toBe("0.124.55");
    expect(chantMeets("0.124.84", "CI_CHECK_HOOK_FLOOR")).toBe(true);
    expect(chantMeets("0.124.54", "CI_CHECK_HOOK_FLOOR")).toBe(false);
    expect(FLOOR_TABLE.filter((r) => r.name === "RELEASE_VERSION_FLOOR").map((r) => r.version).sort()).toEqual(["0.124.55", "0.124.79"]);
    expect(floorVersion("RELEASE_VERSION_FLOOR")).toBe("0.124.79");
    expect(floorVersion("NO_SUCH_FLOOR")).toBeUndefined();
  });

  it("names the subpaths a product imports a floor from", () => {
    const stand = FLOOR_TABLE.find((r) => r.name === "OP_WAVE_STAND_DOWN_FLOOR")!;
    expect(stand.modules).toContain("@intentius/chant/op");
    expect(stand.issue).toBe("#4581");
  });
});
