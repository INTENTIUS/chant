/**
 * An otel member's clickhouse exporter linked to the sql member that declares
 * its tables (#4397), end to end through `chant workspace check`. Both
 * members are folded, never run: the sql member's tables and columns are its
 * outputs (#3931), and the otel lexicon's `workspaceLinks` hook states a link
 * to each table the exporter writes and each column its insert names.
 * Renaming one of those tables in the sql member fails the check (WSP093) at
 * the exporter's declaration.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4397-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const WORKSPACE = JSON.stringify(
  {
    name: "observability",
    schema: 1,
    members: [
      { name: "warehouse", dir: "warehouse", kind: "chant" },
      { name: "collector", dir: "collector", kind: "chant" },
    ],
  },
  null,
  2,
);

const COLLECTOR = [
  `import { ClickHouseExporter, OtlpReceiver, Pipeline } from "@intentius/chant-lexicon-otel";`,
  ``,
  `export const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });`,
  ``,
  `export const clickhouse = new ClickHouseExporter({ endpoint: "tcp://clickhouse:9000", database: "otel", create_schema: false });`,
  ``,
  `export const logs = new Pipeline({ signal: "logs", receivers: [otlp], exporters: [clickhouse] });`,
  `export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [clickhouse] });`,
  `export const metrics = new Pipeline({ signal: "metrics", receivers: [otlp], exporters: [clickhouse] });`,
  ``,
].join("\n");

const warehouse = (tables: string) =>
  [`import { OtelTables } from "@intentius/chant-lexicon-sql/clickhouse";`, ``, `export const otel = OtelTables({ database: "otel"${tables} });`, ``].join("\n");

function observability(tables = ""): string {
  return repo({
    "chant.workspace.json": WORKSPACE,
    "warehouse/chant.config.ts": `export default { lexicons: ["sql"], sql: { dialect: "clickhouse" } };\n`,
    "warehouse/src/otel.ts": warehouse(tables),
    "collector/chant.config.ts": `export default { lexicons: ["otel"] };\n`,
    "collector/src/collector.ts": COLLECTOR,
  });
}

describe("an otel member's clickhouse exporter links to the sql member's tables (#4397)", () => {
  test("every table and column the exporter writes resolves against OtelTables", async () => {
    const report = await runDeclarationChecks(observability());
    expect(report.diagnostics.filter((d) => d.ruleId.startsWith("WSP09"))).toEqual([]);
    const rows = report.links.filter((r) => r.consumer === "collector");
    expect(rows.length).toBeGreaterThan(7);
    expect(rows.every((r) => r.status === "resolved" && r.producer === "warehouse")).toBe(true);
    expect(rows.map((r) => ("output" in r ? r.output : undefined))).toEqual(expect.arrayContaining(["otel.otel_logs", "otel.otel_traces.Events", "otel.otel_metrics_exponential_histogram.Scale"]));
  });

  test("renaming a table the exporter writes fails workspace check at the exporter", async () => {
    const report = await runDeclarationChecks(observability(`, tables: { logs: "otel_logs_v2" }`));
    const missing = report.diagnostics.filter((d) => d.ruleId === "WSP093");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((d) => d.file === "collector/src/collector.ts" && d.line === 5)).toBe(true);
    expect(missing[0].message).toMatch(/collector's link to warehouse output otel\.otel_logs.* \(read by lexicon otel from collector\/src\/collector\.ts:5\) does not resolve/);
    expect(report.ok).toBe(false);
  });
});
