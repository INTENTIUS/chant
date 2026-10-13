/**
 * The HCL parser parity comparison (chant #2483), against canned outputs.
 *
 * The classification, the corpus walk, the record replay and the report are
 * exercised without a wasm blob; one test runs the real worker against the
 * parser this checkout resolves, and skips when it does not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectCorpus,
  compareOutputs,
  dedupeInputs,
  formatReport,
  inputId,
  interpolatedStrings,
  readRecord,
  runWorker,
} from "./hcl-parser-parity";

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-parity-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("compareOutputs", () => {
  it("counts identical results and classifies every kind of disagreement", () => {
    const report = compareOutputs(
      [
        { id: "same", result: "tree:{}" },
        { id: "tree", result: 'tree:{"a":1}' },
        { id: "status", result: "tree:{}" },
        { id: "text", result: "error:boom" },
        { id: "only-ref", result: "tree:{}" },
      ],
      [
        { id: "same", result: "tree:{}" },
        { id: "tree", result: 'tree:{"a":2}' },
        { id: "status", result: "error:no" },
        { id: "text", result: "error:bang" },
        { id: "only-cand", result: "tree:{}" },
      ],
    );
    expect(report.compared).toBe(6);
    expect(report.identical).toBe(1);
    expect(report.differences.map((d) => [d.id, d.kind])).toEqual([
      ["only-cand", "missing"],
      ["only-ref", "missing"],
      ["status", "error-status"],
      ["text", "error-text"],
      ["tree", "tree"],
    ]);
    const status = report.differences.find((d) => d.id === "status");
    expect(status?.reference).toBe("tree:{}");
    expect(status?.candidate).toBe("error:no");
  });

  it("treats two identical error messages as identical", () => {
    const report = compareOutputs([{ id: "x", result: "error:same" }], [{ id: "x", result: "error:same" }]);
    expect(report.identical).toBe(1);
    expect(report.differences).toEqual([]);
  });
});

describe("inputId and dedupeInputs", () => {
  it("keys an input by kind, filename and content, not by where it was found", () => {
    expect(inputId("parse", "main.tf", "a = 1")).toBe(inputId("parse", "main.tf", "a = 1"));
    expect(inputId("parse", "main.tf", "a = 1")).not.toBe(inputId("refs", "main.tf", "a = 1"));
    expect(inputId("parse", "main.tf", "a = 1")).not.toBe(inputId("parse", "other.tf", "a = 1"));
    expect(inputId("parse", "main.tf", "a = 1")).not.toBe(inputId("parse", "main.tf", "a = 2"));
  });

  it("keeps the first of two inputs with the same id", () => {
    const a = { id: "k", kind: "parse" as const, filename: "f", text: "t", label: "first" };
    const b = { ...a, label: "second" };
    const c = { ...a, id: "other", label: "third" };
    expect(dedupeInputs([a, b, c]).map((i) => i.label)).toEqual(["first", "third"]);
  });
});

describe("readRecord", () => {
  it("replays parse and refs lines and skips anything else", () => {
    const content = [
      JSON.stringify({ kind: "parse", filename: "main.tf", text: 'a = "b"' }),
      "",
      "not json",
      JSON.stringify({ kind: "other", filename: "x", text: "y" }),
      JSON.stringify({ kind: "refs", filename: "expression.tf", text: "${var.x}" }),
      JSON.stringify({ kind: "refs", filename: "expression.tf" }),
    ].join("\n");
    const inputs = readRecord(content, "suite");
    expect(inputs.map((i) => [i.kind, i.filename, i.text, i.label])).toEqual([
      ["parse", "main.tf", 'a = "b"', "suite:1"],
      ["refs", "expression.tf", "${var.x}", "suite:5"],
    ]);
    expect(inputs[0].id).toBe(inputId("parse", "main.tf", 'a = "b"'));
  });
});

describe("collectCorpus", () => {
  it("walks .tf and .hcl files, skipping node_modules and .terraform", () => {
    const root = tempDir();
    mkdirSync(join(root, "app", "modules", "cdn"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "app", ".terraform", "modules"), { recursive: true });
    writeFileSync(join(root, "app", "main.tf"), 'resource "x" "y" {}\n');
    writeFileSync(join(root, "app", "estate.chdf.hcl"), 'estate = "e"\n');
    writeFileSync(join(root, "app", "modules", "cdn", "main.tf"), "a = 1\n");
    writeFileSync(join(root, "app", "README.md"), "# not hcl\n");
    writeFileSync(join(root, "app", "vars.tfvars"), "a = 1\n");
    writeFileSync(join(root, "node_modules", "pkg", "vendored.tf"), "a = 1\n");
    writeFileSync(join(root, "app", ".terraform", "modules", "m.tf"), "a = 1\n");
    const inputs = collectCorpus([root], root);
    expect(inputs.map((i) => i.label).sort()).toEqual(["app/estate.chdf.hcl", "app/main.tf", "app/modules/cdn/main.tf"]);
    expect(inputs.every((i) => i.kind === "parse")).toBe(true);
    expect(inputs.find((i) => i.label === "app/main.tf")?.filename).toBe("main.tf");
    expect(inputs.find((i) => i.label === "app/main.tf")?.text).toBe('resource "x" "y" {}\n');
  });

  it("returns nothing for a root that does not exist", () => {
    expect(collectCorpus([join(tempDir(), "missing")], "/")).toEqual([]);
  });
});

describe("interpolatedStrings", () => {
  it("finds every interpolated string anywhere in the tree, once, sorted", () => {
    const tree = {
      resource: { aws_s3_bucket: { a: [{ bucket: "${var.name}", tags: { env: "${var.env}", plain: "x" } }] } },
      locals: [{ z: "${var.name}" }],
      provider: { aws: [{ region: "${var.region}" }] },
    };
    expect(interpolatedStrings(tree)).toEqual(["${var.env}", "${var.name}", "${var.region}"]);
  });
});

describe("formatReport", () => {
  it("prints the totals, a per-kind breakdown, and the first differences with their labels", () => {
    const report = compareOutputs(
      [
        { id: "a", result: 'tree:{"k":1}' },
        { id: "b", result: "tree:{}" },
        { id: "c", result: "tree:{}" },
      ],
      [
        { id: "a", result: 'tree:{"k":2}' },
        { id: "b", result: "error:x" },
        { id: "c", result: "tree:{}" },
      ],
    );
    const text = formatReport(report, { show: 1, labels: new Map([["a", "fixtures/main.tf"]]) });
    expect(text).toContain("1/3 identical, 2 different");
    expect(text).toContain("error-status  1");
    expect(text).toContain("tree          1");
    expect(text).toContain("--- a  (fixtures/main.tf)  [tree]");
    expect(text).toContain('"k": 1');
    expect(text).toContain('"k": 2');
    expect(text).toContain("1 more differences not shown");
    expect(text).not.toContain("--- b");
  });

  it("says so when everything is identical", () => {
    const text = formatReport(compareOutputs([{ id: "a", result: "tree:{}" }], [{ id: "a", result: "tree:{}" }]));
    expect(text).toBe("HCL parser parity: 1/1 identical, 0 different");
  });
});

describe("runWorker (real parser)", () => {
  let parserDir: string | undefined;
  try {
    const require = createRequire(join(dirname(__dirname), "package.json"));
    parserDir = dirname(require.resolve("@cdktn/hcl2json/package.json"));
  } catch {
    parserDir = undefined;
  }

  it.skipIf(parserDir === undefined)("parses each input once and derives a refs output per interpolated string", async () => {
    const source = 'resource "aws_s3_bucket" "a" {\n  bucket = var.name\n  tags = { env = "${var.env}" }\n}\n';
    const inputs = [
      { id: inputId("parse", "main.tf", source), kind: "parse" as const, filename: "main.tf", text: source },
      { id: inputId("parse", "main.tf", source), kind: "parse" as const, filename: "main.tf", text: source },
      { id: inputId("parse", "bad.tf", "resource {"), kind: "parse" as const, filename: "bad.tf", text: "resource {" },
      { id: inputId("refs", "expression.tf", "${var.name}"), kind: "refs" as const, filename: "expression.tf", text: "${var.name}" },
    ];
    const outputs = await runWorker(parserDir as string, inputs);
    const byId = new Map(outputs.map((o) => [o.id, o.result]));
    expect(outputs.length).toBe(4);
    expect(byId.get(inputs[0].id)).toBe(
      'tree:{"resource":{"aws_s3_bucket":{"a":[{"bucket":"${var.name}","tags":{"env":"${var.env}"}}]}}}',
    );
    expect(byId.get(inputs[2].id)?.startsWith("error:")).toBe(true);
    expect(byId.get(inputId("refs", "expression.tf", "${var.name}"))).toBe('refs:["var.name"]');
    expect(byId.get(inputId("refs", "expression.tf", "${var.env}"))).toBe('refs:["var.env"]');
  });
});
