/**
 * The diagram checks, WSP131 to WSP133 (#2764).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { sha256Hex } from "../../content-digest";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-diagrams-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const renderer = { tool: "d2", version: "0.9.0", args: ["--layout=elk", "--theme=0", "--pad=40", "--omit-version"] };
const diagram = (extra: Record<string, unknown> = {}) => ({
  name: "architecture",
  title: "Studio architecture",
  source: "docs/diagrams/architecture.d2",
  render: "docs/diagrams/architecture.svg",
  renderer,
  ...extra,
});

const declaration = (diagrams: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "acme", schema: 1, members: [{ name: "docs", dir: "docs", kind: "other", because: "the docs site", diagrams }], ...extra }, null, 2);

/** The findings, less WSP009, which every member of kind other gets. */
const found = async (root: string) => (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => d.ruleId !== "WSP009");

describe("diagram-source-missing (WSP131) and diagram-render-missing (WSP132)", () => {
  test("both files present passes", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram()]),
      "docs/diagrams/architecture.d2": "x -> y",
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    expect(await found(root)).toEqual([]);
  });

  test("a missing source fails WSP131, and a missing render fails WSP132, each once", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram()]),
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.code, x.entity])).toEqual([["WSP131", "diagram-source-missing", "docs"]]);
    expect(d[0].message).toContain("member docs's diagram architecture names the source docs/diagrams/architecture.d2, which does not exist");
  });

  test("no source (an SVG with none) is never checked for a source", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram({ source: null })]),
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    expect(await found(root)).toEqual([]);
  });

  test("a missing render fails WSP132", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram()]),
      "docs/diagrams/architecture.d2": "x -> y",
    });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.code])).toEqual([["WSP132", "diagram-render-missing"]]);
  });

  test("the top-level (workspace's own) diagrams are checked too, reported with no entity", async () => {
    const root = repo({ "chant.workspace.json": declaration([], { diagrams: [diagram({ name: "boundary" })] }), "docs/README.md": "" });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.entity])).toEqual([
      ["WSP131", undefined],
      ["WSP132", undefined],
    ]);
    expect(d[0].message).toContain("the workspace's own diagram boundary names the source");
  });
});

describe("diagram-render-drift (WSP133)", () => {
  const SOURCE = "x -> y\n";
  const HASH = sha256Hex(Buffer.from(SOURCE, "utf-8"));

  test("no recorded sourceHash: never checked for drift, even when the source changed", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram()]),
      "docs/diagrams/architecture.d2": "something else entirely",
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    expect(await found(root)).toEqual([]);
  });

  test("a recorded sourceHash that matches the source passes", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram({ sourceHash: HASH })]),
      "docs/diagrams/architecture.d2": SOURCE,
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    expect(await found(root)).toEqual([]);
  });

  test("a source that changed since the recorded hash fails WSP133, without running any renderer", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram({ sourceHash: HASH })]),
      "docs/diagrams/architecture.d2": "x -> y -> z\n",
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    const d = await found(root);
    expect(d.map((x) => [x.ruleId, x.code])).toEqual([["WSP133", "diagram-render-drift"]]);
    expect(d[0].message).toContain("source docs/diagrams/architecture.d2 changed since docs/diagrams/architecture.svg was rendered from it");
    expect(d[0].message).toContain(`recorded sourceHash ${HASH.slice(0, 12)}`);
  });

  test("a missing source is left to WSP131; WSP133 finds nothing to compare", async () => {
    const root = repo({
      "chant.workspace.json": declaration([diagram({ sourceHash: HASH })]),
      "docs/diagrams/architecture.svg": "<svg></svg>",
    });
    const d = await found(root);
    expect(d.map((x) => x.ruleId)).toEqual(["WSP131"]);
  });
});
