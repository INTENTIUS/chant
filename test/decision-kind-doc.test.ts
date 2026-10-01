/**
 * chant #2555, ws-064: reference/decision-kind.mdx is the decision kind's
 * specification, so its tables follow docs/design/decisions/decision.kind.mjs.
 * Fails when the kind gains a key, a state, a closed state or a rank the page
 * does not state, or the page states one the kind does not have.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..");
const PAGE = readFileSync(join(REPO, "docs/src/content/docs/reference/decision-kind.mdx"), "utf-8");

type Kind = {
  name: string;
  states: string[];
  closedStates: string[];
  approval: Record<string, number>;
  seal: { field: string };
  spec: boolean;
  schema: { id: string };
};

async function kind(): Promise<Kind & Record<string, unknown>> {
  const mod = (await import(join(REPO, "docs/design/decisions/decision.kind.mjs"))) as { recordKind: Kind & Record<string, unknown> };
  return mod.recordKind;
}

/** The rows of the table under a `## heading`, each as its cells. */
function table(heading: string): string[][] {
  const at = PAGE.indexOf(`\n## ${heading}\n`);
  expect(at, `no section ${heading}`).toBeGreaterThan(-1);
  const lines = PAGE.slice(at).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
}

const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

describe("the decision kind page", () => {
  test("the states table has each state, whether it is closed, and its approval rank", async () => {
    const k = await kind();
    const rows = table("States");
    expect(rows.map((r) => ticked(r[0])[0])).toEqual(k.states);
    for (const [cell, , closed, rank] of rows) {
      const state = ticked(cell)[0];
      expect(closed, state).toBe(k.closedStates.includes(state) ? "yes" : "no");
      expect(Number(rank), state).toBe(k.approval[state]);
    }
  });

  test("the kind keys table names every key of the kind, and no other", async () => {
    const k = await kind();
    const named = table("Kind keys and the record contract").flatMap((r) => ticked(r[0]));
    expect([...named].sort()).toEqual(Object.keys(k).sort());
  });

  test("the name, schema id, seal field and spec flag are the kind's", async () => {
    const k = await kind();
    expect(k).toMatchObject({ name: "decision", schema: { id: "urn:intentius:chant:decision:1" }, seal: { field: "closed_digest" }, spec: true });
    expect(PAGE).toContain(`\`${k.schema.id}\``);
    expect(PAGE).toContain(`{ field: "${k.seal.field}" }`);
  });
});
