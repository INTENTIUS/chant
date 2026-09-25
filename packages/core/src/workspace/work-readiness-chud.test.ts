/**
 * The work kind's `ready`/`blockedBy` against chud's ready queue (ws-055,
 * #2734).
 *
 * chud's `readyQueue` (packages/runtime/src/ready.mjs at jhgaylor/chud
 * 43afcf1) puts a contract in the ready set once it is approved and in
 * force, every `depends_on` id is `met` (drivers.mjs's `memberState`), and no
 * unit is open against it; a contract that is itself met leaves the queue.
 *
 * Of those rules, the work kind's `ready` and `blockedBy` (work.ts) can
 * express two directly, with no new field:
 *
 * - dependencies closed: a work item's `needs` id counts as closed once its
 *   `state` is the kind's `done` state, same as `depends_on` counts a
 *   dependency closed once it is `met`. A `needs` id that never reaches
 *   `done` (here, one that is `dropped`) blocks forever, the same way a
 *   retired contract does.
 * - a record that is itself already `done` (or `dropped`, or merely
 *   `in-progress`) is not `ready`: `ready` requires `state === "open"`, the
 *   same "already met/already running leaves the queue" rule ready.mjs
 *   states for a contract that is itself met.
 *
 * The rules ready.mjs adds on top -- approval before a dependency counts
 * (memberState's draft/failing cases), re-checking that a `met` dependency's
 * newest evidence still passes, and refusing a contract while a unit is open
 * against it -- have no equivalent in a `needs` link. The full table of
 * every ready.mjs rule and its home (a `needs` link, the runner, or "not
 * applicable") is on INTENTIUS/chant#2734.
 *
 * This fixture mirrors a small chud contract graph as work items and checks
 * `queryRecords`'s `ready`/`blockedBy` against a minimal, local
 * re-implementation of the expressible subset of ready.mjs's rule (met
 * depends_on, self not already met), so a regression in either the work
 * kind's readiness formula or this reading of ready.mjs's rule shows up as a
 * mismatch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, REPO, repo } from "./__fixtures__/contract-repo";
import { queryRecords } from "./records-cli";

const REF = join(REPO, "reference-workspace");
const WORK = "work/work.kind.mjs";

function work(id: string, fields: Record<string, unknown>): string {
  const data = {
    schema: 1,
    id,
    title: `Work ${id}`,
    state: "open",
    implements: [],
    needs: [],
    constrains: ["member:app"],
    evidence: [],
    opened_on: "2026-09-24",
    source: { kind: "workspace", member: "app" },
    supersedes: [],
    ...fields,
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

/**
 * The expressible subset of ready.mjs's rule, on a graph shaped like
 * `depends_on`: ready once the item is `open` (not already met, not already
 * running) and every dependency is `done` (chud's "met"). A dependency that
 * is `dropped` never becomes done, so it blocks forever -- the same effect
 * ready.mjs gets from a retired dependency.
 */
function chudReadyIsh(items: { id: string; state: string; needs: string[] }[]): { ready: Set<string>; blockedBy: Map<string, string[]> } {
  const stateOf = new Map(items.map((i) => [i.id, i.state]));
  const ready = new Set<string>();
  const blockedBy = new Map<string, string[]>();
  for (const item of items) {
    const unmet = item.needs.filter((id) => stateOf.get(id) !== "done");
    blockedBy.set(item.id, unmet);
    if (item.state === "open" && unmet.length === 0) ready.add(item.id);
  }
  return { ready, blockedBy };
}

let root: string;

beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "w", schema: 1, members: [] }, null, 2),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    // W-001: already done, so it leaves the ready queue -- ready.mjs's "a
    // contract that is itself met is done, not ready".
    "work/W-001-base.md": work("W-001", { state: "done", closed_on: "2026-09-24", evidence: [{ title: "shipped", url: "https://example.com/w1" }] }),
    // W-002: needs W-001, which is done -- both rules agree this is ready.
    "work/W-002-after-base.md": work("W-002", { needs: ["W-001"] }),
    // W-003: needs W-004, which is dropped and so never turns done -- blocked
    // forever, the same as a retired dependency in ready.mjs.
    "work/W-003-needs-dropped.md": work("W-003", { needs: ["W-004"] }),
    "work/W-004-dropped.md": work("W-004", { state: "dropped", closed_on: "2026-09-24" }),
    // W-005: needs W-002, which is open (not done yet) -- blocked.
    "work/W-005-needs-open.md": work("W-005", { needs: ["W-002"] }),
    // W-006: already in-progress -- not ready, the same "already running"
    // leaves-the-queue rule as a met contract with an open unit does not
    // apply here in the same way, but "not open, so not ready" is shared.
    "work/W-006-in-progress.md": work("W-006", { state: "in-progress" }),
    // W-007: needs W-006, which is in-progress, not done -- blocked.
    "work/W-007-needs-in-progress.md": work("W-007", { needs: ["W-006"] }),
  });
});
afterAll(cleanScratch);

describe("work kind ready/blockedBy vs. chud's ready queue, expressible rules (#2734)", () => {
  test("matches on every item, for the rules a needs link can express", async () => {
    const doc = await queryRecords({ kind: WORK, cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.summary).toEqual({ total: 7, valid: 7, invalid: 0, superseded: 0 });

    const items = doc.records.map((r) => ({ id: r.id!, state: r.state!, needs: (r.data as { needs?: string[] }).needs ?? [] }));
    const chud = chudReadyIsh(items);

    for (const r of doc.records) {
      const id = r.id!;
      expect(r.ready, `${id}.ready`).toBe(chud.ready.has(id));
      expect(
        (r.blockedBy ?? []).map((b) => b.id),
        `${id}.blockedBy`,
      ).toEqual(chud.blockedBy.get(id));
    }
  });

  test("individually: done leaves the queue, a dropped need blocks forever, an in-progress need still blocks", async () => {
    const doc = await queryRecords({ kind: WORK, cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    const by = Object.fromEntries(doc.records.map((r) => [r.id, r]));

    expect(by["W-001"]).toMatchObject({ ready: false, blockedBy: [] }); // done: no longer ready
    expect(by["W-002"]).toMatchObject({ ready: true, blockedBy: [] }); // needs W-001, which is done
    expect(by["W-003"]).toMatchObject({ ready: false, blockedBy: [{ id: "W-004", state: "dropped" }] }); // needs a dropped item: blocked forever
    expect(by["W-005"]).toMatchObject({ ready: false, blockedBy: [{ id: "W-002", state: "open" }] }); // needs an open (not yet done) item
    expect(by["W-006"]).toMatchObject({ ready: false, blockedBy: [] }); // in-progress: not ready, but not "blocked" either
    expect(by["W-007"]).toMatchObject({ ready: false, blockedBy: [{ id: "W-006", state: "in-progress" }] });
  });
});
