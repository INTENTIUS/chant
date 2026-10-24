/**
 * `chant import --validate` for a translated schema (#4398): create the
 * emitted DDL on the pinned ClickHouse server, as `chant migrate --validate`
 * runs the emitted YAML through the target's linter.
 *
 * `validateOnEmulator` starts its own throwaway container of the pinned image
 * (`../clickhouse/container.ts`) and removes it afterwards. It never reads
 * `CLICKHOUSE_URL`, so a validation cannot reach a server that holds data.
 * `validateStatements` is the part that needs no Docker: it runs statements
 * through any `run` function, in the order a server needs them (databases,
 * then tables, then views), and turns each refusal into an `error`
 * diagnostic naming the object.
 */

import type { ImportDiagnostic, TemplateIR } from "@intentius/chant/import/parser";
import { CLICKHOUSE_ENTITY_TYPES } from "../clickhouse/entities";
import { ClickHouseQueryError, clickhouseQuery } from "../clickhouse/http";
import { dockerAvailable, startScratchServer } from "../clickhouse/container";
import { clickhouseImage } from "../spec/pin";

export interface ValidationStatement {
  /** The object, as the diagnostic names it. */
  name: string;
  ddl: string;
  type: string;
}

const RANK: Record<string, number> = {
  [CLICKHOUSE_ENTITY_TYPES.database]: 0,
  [CLICKHOUSE_ENTITY_TYPES.table]: 1,
  [CLICKHOUSE_ENTITY_TYPES.view]: 2,
  [CLICKHOUSE_ENTITY_TYPES.materializedView]: 2,
};

/** The IR's ClickHouse objects as statements in creation order. */
export function statementsOf(ir: TemplateIR): ValidationStatement[] {
  const out = ir.resources.map((r, i) => {
    const p = r.properties as { database?: string; name: string; ddl: string };
    return { name: p.database ? `${p.database}.${p.name}` : p.name, ddl: p.ddl, type: r.type, i };
  });
  return out
    .sort((a, b) => (RANK[a.type] ?? 3) - (RANK[b.type] ?? 3) || a.i - b.i)
    .map(({ name, ddl, type }) => ({ name, ddl, type }));
}

/** Run each statement; a refusal is an error diagnostic, and the run goes on to the next. */
export async function validateStatements(statements: readonly ValidationStatement[], run: (sql: string) => Promise<void>): Promise<ImportDiagnostic[]> {
  const out: ImportDiagnostic[] = [];
  for (const s of statements) {
    try {
      await run(s.ddl);
    } catch (e) {
      const msg = e instanceof ClickHouseQueryError ? e.serverMessage.trim().split("\n")[0]! : e instanceof Error ? e.message : String(e);
      out.push({ ruleId: "SQLRV012", severity: "error", message: `${s.name}: the emulator rejected the statement. ${msg}`, entity: s.name });
    }
  }
  return out;
}

/**
 * Create the IR's objects on a throwaway server of the pinned image. Throws,
 * naming the cause, when Docker is not available: the caller reports that the
 * validation did not run, rather than reporting a pass.
 */
export async function validateOnEmulator(ir: TemplateIR): Promise<ImportDiagnostic[]> {
  if (ir.resources.some((r) => r.type.startsWith("Postgres::"))) throw new Error("--validate checks ClickHouse DDL; this template holds Postgres objects");
  if (!(await dockerAvailable())) throw new Error("Docker is not available, so the ClickHouse emulator cannot start");
  const server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-import-validate" });
  try {
    return await validateStatements(statementsOf(ir), async (sql) => {
      await clickhouseQuery(server.endpoint, sql);
    });
  } finally {
    await server.stop();
  }
}
