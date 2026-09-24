/**
 * chant #2657 — the owner roster for the chant and hud boundary, held to the
 * code (ws-052).
 *
 * `docs/data/boundary.yaml` has one row per concept, with its owner (chant,
 * hud or plugin) and what carries it. This file fails when the roster and
 * the code disagree in either direction:
 *
 * - a `chant workspace` command, member kind, member or record link kind,
 *   intent node or edge kind, reason code, finding code or `WSP` id exists in
 *   code and has no row;
 * - a row in one of those categories names something the code does not have.
 *
 * It also holds the rows to the boundary itself: everything in chant's
 * closed lists is owned by chant, the node kinds the intent schema joins from
 * a plugin are owned by a plugin, every hud row is carried by alecraso/hud,
 * each code's row names exactly the output schemas that carry it, and the
 * reference page is what the roster renders.
 *
 * Everything here is read statically or imported; no command runs.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { commandRegistry } from "../packages/core/src/cli/main";
import { WORKSPACE_CHECKS } from "../packages/core/src/workspace/checks";
import { INTENT_FINDING_CODES } from "../packages/core/src/workspace/intent";
import { BUILTIN_KIND_NAMES } from "../packages/core/src/workspace/kinds";
import { LINK_KINDS } from "../packages/core/src/workspace/links";
import { RECORD_LINK_KINDS } from "../packages/core/src/workspace/record-assets";
import { REASON_CODES } from "../packages/core/src/workspace/reason-codes";
import { BOUNDARY_PAGE, parseRoster, readRoster, renderBoundaryPage, type Category, type RosterRow } from "../scripts/boundary-roster";

const repoRoot = resolve(import.meta.dirname, "..");
const workspaceSrc = join(repoRoot, "packages", "core", "src", "workspace");
const { rows, problems } = readRoster(repoRoot);

const schema = (name: string) => JSON.parse(readFileSync(join(workspaceSrc, name), "utf-8")) as { $defs: Record<string, { properties?: Record<string, { const?: string; enum?: string[] }>; oneOf?: { $ref: string }[] }> };
const intentSchema = schema("intent.schema.json");

/** The `kind` values of the `$defs` a `oneOf` of refs points at. */
function kindsOf(union: string): string[] {
  const out: string[] = [];
  for (const { $ref } of intentSchema.$defs[union].oneOf ?? []) {
    const kind = intentSchema.$defs[$ref.replace("#/$defs/", "")].properties?.kind;
    if (kind?.const) out.push(kind.const);
    for (const k of kind?.enum ?? []) out.push(k);
  }
  return out;
}

const FINDING_CODES: readonly string[] = INTENT_FINDING_CODES;
const JOINED_NODE_KINDS = intentSchema.$defs.joined.properties!.kind.enum!;

/** The help text's `workspace` lines, from the CLI source. */
const helpLines = readFileSync(join(repoRoot, "packages", "core", "src", "cli", "main.ts"), "utf-8")
  .split("\n")
  .filter((l) => /^ {2}workspace \S/.test(l))
  .map((l) => l.trim());

/** Every `chant workspace` command: the registry's entries, and each sub-verb the help names (`records pin`, `lineage resolve`). */
function workspaceCommands(): string[] {
  const out = new Set(commandRegistry.map((c) => c.name).filter((n) => n.startsWith("workspace ")));
  for (const l of helpLines) {
    const m = /^(workspace [a-z][a-z-]* [a-z][a-z-]*)(\s|$)/.exec(l);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** A command row exists when the registry has it or a help line starts with it. */
const commandExists = (name: string) => commandRegistry.some((c) => c.name === name) || helpLines.some((l) => l === name || l.startsWith(`${name} `));

/** Every `WSP` id: the catalog's, and any literal in the check sources. */
function wspIds(): string[] {
  const ids = new Set(WORKSPACE_CHECKS.map((c) => c.id));
  const files = ["checks.ts", ...readdirSync(join(workspaceSrc, "checks")).map((f) => `checks/${f}`)].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) for (const m of readFileSync(join(workspaceSrc, f), "utf-8").matchAll(/"(WSP\d{3})"/g)) ids.add(m[1]);
  return [...ids];
}

/** The output schemas that name a code, as the roster's carrier lists them. */
const OUTPUT_SCHEMAS = readdirSync(workspaceSrc).filter((f) => f.endsWith(".schema.json") && f !== "declaration.schema.json" && f !== "workspace-kinds.schema.json").sort();
const schemaText = new Map(OUTPUT_SCHEMAS.map((f) => [f, readFileSync(join(workspaceSrc, f), "utf-8")]));
const schemasNaming = (code: string) => OUTPUT_SCHEMAS.filter((f) => schemaText.get(f)!.includes(`"${code}"`));

/** The rows a closed category must have, straight from the code. */
function inCode(): Partial<Record<Category, string[]>> {
  return {
    command: workspaceCommands(),
    "member-kind": [...BUILTIN_KIND_NAMES],
    "member-link-kind": [...LINK_KINDS],
    "record-link-kind": [...RECORD_LINK_KINDS],
    "intent-node-kind": kindsOf("node"),
    "intent-edge-kind": kindsOf("edge"),
    "reason-code": REASON_CODES.filter((c) => !FINDING_CODES.includes(c)),
    "finding-code": [...FINDING_CODES],
    "wsp-check": wspIds(),
  };
}

/** What a category's rows lack, and what they name that isn't there. */
function gaps(category: Category, roster: RosterRow[], expected: string[], exists: (c: string) => boolean = (c) => expected.includes(c)) {
  const named = roster.filter((r) => r.category === category).map((r) => r.concept);
  return {
    missing: expected.filter((c) => !named.includes(c)).sort(),
    extra: named.filter((c) => !exists(c)).sort(),
  };
}

describe("the boundary roster (#2657)", () => {
  test("the roster parses, with every row's fields and a known category and owner", () => {
    expect(problems).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("the comparison catches a missing row and a row for something that does not exist", () => {
    const { rows: fake } = parseRoster(
      'rows:\n  - { category: "member-kind", concept: "chant", owner: "chant", carrier: "x", what: "x" }\n  - { category: "member-kind", concept: "gone", owner: "chant", carrier: "x", what: "x" }\n',
    );
    expect(gaps("member-kind", fake, ["chant", "workspace"])).toEqual({ missing: ["workspace"], extra: ["gone"] });
  });

  for (const [category, expected] of Object.entries(inCode()) as [Category, string[]][]) {
    test(`${category}: one row for each in the code, and none for anything else`, () => {
      expect(expected.length, `found no ${category} in the code; the scan is broken`).toBeGreaterThan(0);
      const found = gaps(category, rows, expected, category === "command" ? commandExists : undefined);
      expect(found, `missing: a ${category} exists in code with no row in docs/data/boundary.yaml; extra: a row names a ${category} the code does not have`).toEqual({ missing: [], extra: [] });
    });
  }

  test("the intent graph's finding codes are the ones intent.ts emits and are in the closed list", () => {
    expect([...FINDING_CODES].sort()).toEqual([...INTENT_FINDING_CODES].sort());
    for (const c of FINDING_CODES) expect(REASON_CODES).toContain(c);
  });

  test("chant owns every command, kind, link kind, code and WSP id in its closed lists", () => {
    const chantOnly: Category[] = ["command", "member-kind", "member-link-kind", "record-link-kind", "reason-code", "finding-code", "wsp-check"];
    const wrong = rows.filter((r) => chantOnly.includes(r.category) && r.owner !== "chant").map((r) => `${r.category} ${r.concept} (${r.owner})`);
    expect(wrong).toEqual([]);
  });

  test("the node kinds the intent schema joins from a plugin are owned by a plugin, and so are their record kinds", () => {
    for (const k of JOINED_NODE_KINDS) {
      expect(rows.find((r) => r.category === "intent-node-kind" && r.concept === k)?.owner, `intent-node-kind ${k}`).toBe("plugin");
      expect(rows.find((r) => r.category === "record-kind" && r.concept === k)?.owner, `record-kind ${k}`).toBe("plugin");
    }
    const others = rows.filter((r) => r.category === "intent-node-kind" && !JOINED_NODE_KINDS.includes(r.concept));
    expect(others.filter((r) => r.owner !== "chant").map((r) => r.concept)).toEqual([]);
  });

  test("a record kind chant owns names a kind file that exists", () => {
    for (const r of rows.filter((x) => x.category === "record-kind" && x.owner === "chant")) {
      const files = r.carrier.split(/,\s*/).filter((t) => t.endsWith(".kind.mjs"));
      expect(files.length, `${r.concept} names no kind file`).toBeGreaterThan(0);
      for (const f of files) expect(existsSync(join(repoRoot, f)), f).toBe(true);
    }
  });

  test("the hud views are H1 to H11 of #2650, and every hud row is carried by alecraso/hud", () => {
    const views = rows.filter((r) => r.category === "hud-view");
    expect(views.map((r) => r.concept)).toEqual(Array.from({ length: 11 }, (_, i) => `H${i + 1}`));
    for (const r of views) expect(r.reads, `${r.concept} names what it reads`).toBeTruthy();
    const wrong = rows.filter((r) => (r.owner === "hud") !== (r.carrier === "alecraso/hud")).map((r) => `${r.category} ${r.concept}`);
    expect(wrong).toEqual([]);
  });

  test("the boundary table has a row in each column", () => {
    for (const owner of ["chant", "hud", "plugin"]) expect(rows.some((r) => r.category === "area" && r.owner === owner), owner).toBe(true);
  });

  test("each reason and finding code's row names exactly the output schemas that carry it", () => {
    const wrong: string[] = [];
    for (const r of rows.filter((x) => x.category === "reason-code" || x.category === "finding-code")) {
      const want = schemasNaming(r.concept).join(", ");
      if (r.carrier !== want) wrong.push(`${r.concept}: roster says "${r.carrier}", the schemas name it in "${want}"`);
    }
    expect(wrong).toEqual([]);
  });

  test("every schema a row names exists", () => {
    const missing: string[] = [];
    for (const r of rows) {
      // A record kind's schema may sit beside the kind file the same row names.
      const kindDirs = r.carrier
        .split(/,\s*/)
        .filter((t) => t.endsWith(".kind.mjs"))
        .map((t) => dirname(join(repoRoot, t)));
      for (const [name] of r.carrier.matchAll(/[\w.-]+\.schema\.json/g)) {
        const dirs = [workspaceSrc, join(repoRoot, "docs", "design", "decisions"), ...kindDirs];
        if (!dirs.some((d) => existsSync(join(d, name)))) missing.push(`${r.category} ${r.concept}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("each WSP row carries the check's name", () => {
    const wrong = WORKSPACE_CHECKS.filter((c) => rows.find((r) => r.category === "wsp-check" && r.concept === c.id)?.name !== c.name).map((c) => c.id);
    expect(wrong).toEqual([]);
  });

  test("the reference page is what the roster renders (run npx tsx scripts/generate-boundary-doc.ts)", () => {
    expect(readFileSync(join(repoRoot, BOUNDARY_PAGE), "utf-8")).toBe(renderBoundaryPage(rows));
  });
});
