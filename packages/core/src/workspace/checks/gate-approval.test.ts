/**
 * WSP153 (#4404): an Op gate's approval block that `identity.gates` does not
 * set at base.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { gateUses, unbasedFields } from "./gate-approval";
import { REASONS } from "../reason-codes";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-gate-approval-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const op = (approval: unknown): string =>
  JSON.stringify({ name: "release", phases: [{ name: "Gate", parallel: false, steps: [{ kind: "gate", gate: "ship", timeout: "48h", ...(approval ? { approval } : {}) }] }] });
const workspace = (gates: Record<string, unknown> | undefined, opText: string): Record<string, string> => ({
  "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "app" }], ...(gates ? { identity: { gates } } : {}) }),
  "app/dist/ops/release/op.json": opText,
});
const found = async (root: string) =>
  (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => d.ruleId === "WSP153");

describe("WSP153: an approval block base does not back", () => {
  test("a gate with an approval block and no entry at base is reported, with the fields it sets", async () => {
    const [d] = await found(repo(workspace(undefined, op({ quorum: { count: 2 }, mode: "enforce" }))));
    expect(d).toMatchObject({ code: "gate-approval-unbased", severity: "warning", entity: "ship" });
    expect(d.message).toMatch(/gate "ship" in Op release sets quorum, mode in its approval block/);
    expect(d.message).toMatch(/no entry for it at base/);
  });

  test("an entry that sets only some of the fields leaves the rest reported", async () => {
    const root = repo(workspace({ ship: { quorum: { count: 2 } } }, op({ quorum: { count: 2 }, mode: "enforce", context: { risk: "low", team: "x" } })));
    const [d] = await found(root);
    expect(d.message).toMatch(/sets mode, context \(risk, team\)/);
    expect(d.message).toMatch(/identity\.gates\.ship sets none of them/);
  });

  test("an entry that sets every field the Op does is clean", async () => {
    const approval = { quorum: { count: 2 }, mode: "enforce", context: { risk: "low" } };
    const clean = repo(workspace({ ship: { quorum: { count: 2 }, mode: "enforce", context: { risk: "high" } } }, op(approval)));
    expect(await found(clean)).toEqual([]);
  });

  test("a gate with no approval block, or an Op that is not built, is not reported", async () => {
    expect(await found(repo(workspace(undefined, op(undefined))))).toEqual([]);
    expect(await found(repo({ "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "app" }] }) }))).toEqual([]);
  });

  test("it reads gates nested in an effect and in onFailure", () => {
    const uses = gateUses({
      phases: [{ steps: [{ kind: "effect", steps: [{ kind: "gate", gate: "inner", approval: { mode: "enforce" } }] }] }],
      onFailure: [{ steps: [{ kind: "gate", signalName: "undo", approval: { quorum: { count: 2 } } }] }],
    });
    expect(uses.map((u) => u.gate)).toEqual(["inner", "undo"]);
    expect(unbasedFields(uses[0], undefined)).toEqual(["mode"]);
  });

  test("the code is a documented reason code", () => {
    expect(REASONS["gate-approval-unbased"]).toMatch(/identity\.gates does not set at base/);
  });
});
