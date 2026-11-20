/**
 * The report store's schema ids and audit line (#5336), over terragucci's
 * and sql-yodeler's own files (report-store/__fixtures__/README.md).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { ESTATE_TABLES, NOW } from "./__fixtures__/estate-ledger";
import { TERRAGUCCI } from "./__fixtures__/product-words";
import { buildDelivery, buildLedgerEstate, buildRecordDelivery, estateRows, renderEstateHtml } from "./ci-estate";
import { PRODUCT_AUDIT_KINDS, resolveProductWords } from "./ci-product-words";
import { deriveGateAudit } from "./lifecycle/gate-audit";
import type { QueryRow } from "./lifecycle/query";
import { NEXT_RELEASE } from "./release-floors";
import {
  AUDIT_KINDS,
  REPORT_SCHEMA_FILES,
  REPORT_SCHEMAS,
  REPORT_STORE_FLOOR,
  auditKindOf,
  auditLinesFromLedger,
  neutralReport,
  readAuditLine,
  readAuditRecord,
  readReportSchema,
  reportProduct,
  toProductAuditLine,
  writeAuditRecord,
  type AuditLine,
} from "./report-store";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const text = (p: string): string => readFileSync(here(p), "utf8");
const json = (p: string): Record<string, unknown> => JSON.parse(text(p)) as Record<string, unknown>;
const jsonl = (p: string): Record<string, unknown>[] => text(p).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

const TG_AUDIT = "./report-store/__fixtures__/terragucci-audit.jsonl";
const YODEL_AUDIT = "./report-store/__fixtures__/sql-yodeler-audit.jsonl";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaOf = (kind: keyof typeof REPORT_SCHEMAS) => {
  const file = REPORT_SCHEMA_FILES[kind].replace("@intentius/chant/", "./");
  return ajv.getSchema(json(file).$id as string) ?? ajv.compile(json(file));
};
const valid = (kind: keyof typeof REPORT_SCHEMAS, doc: unknown): string[] => {
  const v = schemaOf(kind);
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const tg = resolveProductWords(TERRAGUCCI);

describe("schema ids", () => {
  test("a neutral id and a product-named one read as the same kind", () => {
    expect(readReportSchema("chant.dora/v1")).toEqual({ kind: "dora", neutral: true });
    expect(readReportSchema("terragucci.dora/v1")).toEqual({ kind: "dora", product: "terragucci", neutral: false });
    expect(readReportSchema("terragucci.report/v1")).toEqual({ kind: "run", product: "terragucci", neutral: false });
    expect(readReportSchema("terragucci.run/v1")?.kind).toBe("run");
    expect(readReportSchema("plywood.estate/v1")).toEqual({ kind: "estate", product: "plywood", neutral: false });
    expect(readReportSchema("terragucci.audit/v1")?.kind).toBe("audit");
    expect(readReportSchema("terragucci.inventory/v1")).toBeUndefined();
    expect(readReportSchema(undefined)).toBeUndefined();
  });

  test("the product is named in a field under a neutral id, and by the id otherwise", () => {
    expect(reportProduct({ schema: "chant.estate/v1", product: "plywood" })).toBe("plywood");
    expect(reportProduct({ schema: "terragucci.estate/v1" })).toBe("terragucci");
    const doc = neutralReport(json("./report-store/__fixtures__/terragucci-estate.json") as { schema: string }, "estate", "terragucci");
    expect(Object.keys(doc).slice(0, 2)).toEqual(["schema", "product"]);
    expect(doc).toMatchObject({ schema: REPORT_SCHEMAS.estate, product: "terragucci" });
  });

  test("the floor names the next release", () => {
    expect(REPORT_STORE_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("the published schemas", () => {
  test("each file is in the package under its kind, with the neutral id as its title", () => {
    const pkg = json("../package.json") as { exports: Record<string, unknown> };
    expect(pkg.exports["./report-store/*.schema.json"]).toBeDefined();
    for (const [kind, id] of Object.entries(REPORT_SCHEMAS)) {
      const s = json(REPORT_SCHEMA_FILES[kind as keyof typeof REPORT_SCHEMAS].replace("@intentius/chant/", "./"));
      expect(s.title).toBe(id);
      expect(s.$id).toBe(`https://intentius.io/chant/schemas/report-store/v1/${kind}.schema.json`);
    }
  });

  test("terragucci's estate.json and dora.json validate under their old ids", () => {
    expect(valid("estate", json("./report-store/__fixtures__/terragucci-estate.json"))).toEqual([]);
    expect(valid("dora", json("./ci-estate/__fixtures__/terragucci-dora.json").dora)).toEqual([]);
  });

  test("a neutral id needs its product", () => {
    const dora = json("./ci-estate/__fixtures__/terragucci-dora.json").dora as Record<string, unknown>;
    expect(valid("dora", { ...dora, schema: "chant.dora/v1" })).not.toEqual([]);
    expect(valid("dora", { ...dora, schema: "chant.dora/v1", product: "terragucci" })).toEqual([]);
    expect(valid("run", { schema: "terragucci.report/v1", minor: 34 })).toEqual([]);
    expect(valid("run", { schema: "chant.run/v1" })).not.toEqual([]);
    expect(valid("run", { schema: "chant.run/v1", product: "plywood" })).toEqual([]);
  });

  test("the estate and metrics chant builds validate under either id", () => {
    for (const schemas of ["product", "neutral"] as const) {
      const { estate, dora } = buildLedgerEstate({ load: ESTATE_TABLES, words: tg, now: NOW, schemas });
      expect(valid("estate", estate)).toEqual([]);
      expect(valid("dora", dora)).toEqual([]);
    }
  });
});

describe("the audit line", () => {
  test("its kinds are the vocabulary's", () => {
    expect([...AUDIT_KINDS].sort()).toEqual(Object.keys(PRODUCT_AUDIT_KINDS).sort());
    expect(auditKindOf("approval")).toBe("approved");
    expect(auditKindOf("apply")).toBe("applied");
    expect(auditKindOf("override")).toBe("override-recorded");
    expect(auditKindOf("migration")).toBe("recorded");
  });

  test("every terragucci line maps onto it and back with nothing lost", () => {
    const raw = jsonl(TG_AUDIT);
    const lines = raw.map((r) => readAuditLine(r));
    expect(lines.every((l) => l !== undefined)).toBe(true);
    for (const [i, l] of lines.entries()) {
      expect(valid("audit", l), String(raw[i]!.kind)).toEqual([]);
      expect(toProductAuditLine(l!, "terragucci")).toEqual(raw[i]);
      expect(l!.product).toBe("terragucci");
    }
    const by = (word: string) => lines.find((l) => l!.product_kind === word || (l!.kind === word && !l!.product_kind));
    expect(by("approval")).toMatchObject({ kind: "approved", product_kind: "approval", who: "dana" });
    expect(by("apply")).toMatchObject({ kind: "applied", product_kind: "apply", result: "applied" });
    expect(by("approval-revoked")).toMatchObject({ kind: "revoked" });
    expect(by("override")).toMatchObject({ kind: "override-recorded" });
    expect(by("migration")).toMatchObject({ kind: "recorded" });
    expect(by("approval-requested")).toMatchObject({ kind: "approval-requested" });
    expect(by("approval-requested")!.product_kind).toBeUndefined();
  });

  test("every sql-yodeler line maps onto it and back with nothing lost", () => {
    const raw = jsonl(YODEL_AUDIT);
    expect(new Set(raw.map((r) => r.kind))).toEqual(new Set(["approval-requested", "approved", "override", "silenced", "applied", "refused", "failed", "spent", "repaired", "wave-run"]));
    const lines = raw.map((r) => readAuditLine(r, { project: "github.com/acme/shop" }));
    for (const [i, l] of lines.entries()) {
      expect(l, String(raw[i]!.kind)).toBeDefined();
      expect(valid("audit", l), String(raw[i]!.kind)).toEqual([]);
      expect(toProductAuditLine(l!, "sql-yodeler")).toEqual(raw[i]);
      expect(l).toMatchObject({ product: "sql-yodeler", project: "github.com/acme/shop", environment: "dev" });
    }
    const applied = lines.find((l) => l!.kind === "applied" && l!.detail?.wave)!;
    expect(applied).toMatchObject({ what: "m2", who: "ci@host", result: "applied", evidence: { source: "history", table: "yodeler.history" } });
    expect(lines.find((l) => l!.product_kind === "failed")).toMatchObject({ kind: "applied", result: "failed" });
    expect(lines.find((l) => l!.product_kind === "override")).toMatchObject({ kind: "override-recorded", who: "alice", evidence: { source: "ledger", gate: "override-no-drops" } });
    const approved = lines.find((l) => l!.kind === "approved")!;
    expect(approved).toMatchObject({ what: "approve-migrate-dev", who: "alice" });
    expect(approved).not.toHaveProperty("product_kind");
  });

  test("one record holds lines of every format, and a reader takes them all", () => {
    const neutral = readAuditLine(jsonl(TG_AUDIT)[1]);
    const body = [text(TG_AUDIT).trim(), text(YODEL_AUDIT).trim(), JSON.stringify(neutral), "not json", '{"schema":"terragucci.inventory/v1"}'].join("\n");
    const { lines, unreadable } = readAuditRecord(body);
    expect(lines.length).toBe(19 + 13 + 1);
    expect(unreadable).toEqual([34, 35]);
    expect(lines.at(-1)).toEqual(neutral);
  });
});

describe("the audit line from the ledger", () => {
  const D = "jcs1-sha256:aaaa";
  const ledger = {
    op: "plywood-up",
    path: "_gates/plywood-up.jsonl",
    lines: [
      { record: { version: 1, kind: "pending", op: "plywood-up", gate: "wave-1", timestamp: "2026-10-27T09:00:00.000Z", planDigest: D, expiresAt: "2026-11-03T09:00:00.000Z", runId: "41" }, commit: "c1" },
      { record: { version: 1, op: "plywood-up", gate: "wave-1", timestamp: "2026-10-27T09:05:00.000Z", resolvedBy: "alice", planDigest: D }, commit: "c2" },
    ],
  };
  const { entries } = deriveGateAudit({ ledgers: [ledger], applies: [{ ref: "reports/c3/wave-1.json", at: "2026-10-27T09:10:00.000Z", gate: "wave-1", op: "plywood-up", digest: D, by: "ci" }] });
  const lines = auditLinesFromLedger(entries, { product: "plywood", project: "github.com/acme/stacks" });

  test("is written for any product, with the vocabulary's kinds", () => {
    expect(lines.map((l) => [l.kind, l.result, l.who])).toEqual([
      ["approval-requested", "waiting", null],
      ["approved", "unsigned", "alice"],
      ["applied", "applied", "ci"],
    ]);
    for (const l of lines) expect(valid("audit", l)).toEqual([]);
    expect(lines[0]).toMatchObject({ product: "plywood", what: "wave-1", digest: D, evidence: { source: "ledger", branch: "chant/lifecycle", path: "_gates/plywood-up.jsonl", op: "plywood-up", commit: "c1" } });
    expect(lines[2]!.evidence).toMatchObject({ source: "report", key: "reports/c3/wave-1.json" });
    expect(lines[2]!.detail).toMatchObject({ under: lines[1]!.id });
  });

  test("the report store appends the lines its record lacks and keeps every line it holds", async () => {
    const store = new Map<string, string>([["audit.jsonl", text(TG_AUDIT)]]);
    const put = async (k: string, b: string): Promise<void> => void store.set(k, b);
    const get = async (k: string): Promise<string | null> => store.get(k) ?? null;
    expect(await writeAuditRecord(lines, { put, get })).toEqual({ key: "audit.jsonl", added: 3 });
    expect(store.get("audit.jsonl")!.startsWith(text(TG_AUDIT))).toBe(true);
    expect(await writeAuditRecord([...lines, ...lines], { put, get })).toEqual({ key: "audit.jsonl", added: 0 });
    const read = readAuditRecord(store.get("audit.jsonl")!);
    expect(read.unreadable).toEqual([]);
    expect(read.lines.slice(-3)).toEqual(lines);
    expect(await writeAuditRecord(lines, { put, get, key: "plywood/audit.jsonl" })).toEqual({ key: "plywood/audit.jsonl", added: 3 });
  });

  test("delivery metrics read the neutral line as they read terragucci's, and give terragucci's dora.json", () => {
    const golden = json("./ci-estate/__fixtures__/terragucci-dora.json") as { now: string; sources: never[]; entries: never[]; dora: unknown };
    const neutral = golden.entries.map((r) => readAuditLine(r)!);
    expect(neutral.map((l) => l.kind)).toContain("applied");
    const options = { stages: { plan: "tf-plan", drift: "tf-drift" }, words: tg, now: new Date(golden.now) };
    expect(buildRecordDelivery(golden.sources, neutral as never[], options)).toEqual(golden.dora);
    expect(buildRecordDelivery(golden.sources, neutral as never[], { ...options, schemas: "neutral" })).toEqual({ ...(golden.dora as object), schema: "chant.dora/v1", product: "terragucci" });
  });
});

describe("ci-estate's ids and the release ledger", () => {
  test("the product-named ids stay the default, and neutral writes the product beside the neutral id", () => {
    const old = buildLedgerEstate({ load: ESTATE_TABLES, words: tg, now: NOW });
    expect(old.estate.schema).toBe("terragucci.estate/v1");
    expect(old.dora.schema).toBe("terragucci.dora/v1");
    expect(old.estate).not.toHaveProperty("product");
    const neutral = buildLedgerEstate({ load: ESTATE_TABLES, words: tg, now: NOW, schemas: "neutral" });
    expect(neutral.estate).toMatchObject({ schema: "chant.estate/v1", product: "terragucci" });
    expect(neutral.dora).toMatchObject({ schema: "chant.dora/v1", product: "terragucci" });
    expect({ ...neutral.dora, schema: undefined, product: undefined }).toEqual({ ...old.dora, schema: undefined });
  });

  const deploy = (member: string, env: string, timestamp: string, more: Partial<QueryRow> = {}): QueryRow => ({
    member, env, component: "app", digest: "sha256:d", git_sha: "c1", run_id: `run-${timestamp}`, forge: null, run_url: null, timestamp, actor: "ci", approver: null, release_digest: null, digest_kind: null, promoted_from: null, restores: null, redeploys: null, unchanged_since: null, ...more,
  });
  const deploys: QueryRow[] = [
    deploy("network", "dev", "2026-10-20T10:00:00.000Z"),
    deploy("network", "prod", "2026-10-21T10:00:00.000Z", { promoted_from: JSON.stringify({ env: "dev", runId: "run-1" }) }),
    deploy("network", "prod", "2026-10-26T10:00:00.000Z", { promoted_from: JSON.stringify({ env: "dev", runId: "run-2" }) }),
    deploy("network", "prod", "2026-10-26T12:00:00.000Z", { restores: JSON.stringify({ runId: "run-1", timestamp: "2026-10-21T10:00:00.000Z" }) }),
    deploy("web", "prod", "2026-10-26T13:00:00.000Z", { redeploys: JSON.stringify({ runId: "run-9" }) }),
    deploy("web", "prod", "2026-01-01T00:00:00.000Z", { promoted_from: JSON.stringify({ env: "dev" }) }),
  ];

  test("DORA counts the promotes and rollbacks on the ledger, per member, for the estate and by week", () => {
    const rows = estateRows({ ...ESTATE_TABLES, deploys });
    expect(rows.releases?.map((d) => d.verb)).toEqual(["deploy", "promote", "promote", "rollback", "redeploy", "promote"]);
    const dora = buildDelivery(rows, { words: tg, now: NOW });
    expect(dora.estate.releases).toEqual({ deploys: 1, promotes: 2, rollbacks: 1, redeploys: 1 });
    expect(dora.projects.find((p) => p.project === "network")!.releases).toEqual({ deploys: 1, promotes: 2, rollbacks: 1, redeploys: 0 });
    expect(dora.projects.find((p) => p.project === "web")!.releases).toEqual({ deploys: 0, promotes: 0, rollbacks: 0, redeploys: 1 });
    expect(dora.estate.trend.at(-1)).toMatchObject({ week: "2026-10-26", promotes: 1, rollbacks: 1 });
    expect(dora.estate.trend.at(-2)).toMatchObject({ week: "2026-10-19", promotes: 1, rollbacks: 0 });
    expect(valid("dora", dora)).toEqual([]);
    expect(renderEstateHtml(buildLedgerEstate({ load: { ...ESTATE_TABLES, deploys }, words: tg, now: NOW }).estate, dora, tg)).toContain('id="dora-releases"');
  });

  test("a ledger with no deploy record leaves the metrics as they were", () => {
    const without = buildDelivery(estateRows(ESTATE_TABLES), { words: tg, now: NOW });
    expect(without.estate).not.toHaveProperty("releases");
    expect(without.estate.trend[0]).not.toHaveProperty("promotes");
    expect(buildDelivery(estateRows({ ...ESTATE_TABLES, deploys: [] }), { words: tg, now: NOW })).toEqual(without);
  });
});
