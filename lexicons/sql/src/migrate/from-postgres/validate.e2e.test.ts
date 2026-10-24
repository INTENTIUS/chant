/**
 * Fourth Done-when box of #4399: `--validate` creates the translated example
 * on the pinned ClickHouse server, as a bare table and as a `CdcMirror` call
 * with its view, and reports a statement the server refuses by name.
 *
 * Needs Docker; skips cleanly without it. One throwaway container per call,
 * removed afterwards even on failure. Written, not run, in the session that
 * added it (no e2e and no Docker, by the brief).
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dockerAvailable } from "../../clickhouse/container";
import type { Declarable } from "@intentius/chant/declarable";
import { transform } from "./index";
import * as source from "../../../examples/postgres-cdc-source/src/shop";
import { translatePostgres } from "./translate";

const enabled = await dockerAvailable();
const sourceFile = join(import.meta.dirname, "../../../examples/postgres-cdc-source");

describe.skipIf(!enabled)("the emulator accepts the translated example", () => {
  test.each([
    ["bare tables", false],
    ["CdcMirror calls and their views", true],
  ])("every statement of %s is created", async (_name, useComposites) => {
    const r = await transform("", { emit: "ts", useComposites, sourceFile });
    const found = await r.validate!();
    expect(found, found.map((d) => String(d.message)).join("\n")).toEqual([]);
  }, 300_000);

  test("a statement the server refuses is an error naming the table", async () => {
    // A key column the table does not have is caught by the server, not by the translator.
    const entities = new Map(Object.entries(source) as Array<[string, Declarable]>);
    const t = translatePostgres(entities, { composite: false });
    t.mirrors[0]!.primaryKey = ["no_such_column"];
    const { validateOnEmulator } = await import("../../sqlserver/validate");
    const { objectsToIR } = await import("../../clickhouse/import/ir");
    const { mirrorObjects } = await import("./emit");
    const found = await validateOnEmulator(objectsToIR(mirrorObjects(t.mirrors, false)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ruleId: "SQLRV012", severity: "error", entity: "customers" });
  }, 300_000);
});
