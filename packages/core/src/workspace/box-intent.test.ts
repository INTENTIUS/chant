/**
 * A box's intent (#2850): the decision record the box block names, as
 * `status --json` reports it, as `check` finds it (WSP126, WSP127) and as
 * `graph --intent` shows it for the box's files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, REPO, repo } from "./__fixtures__/contract-repo";
import { constrainsBox } from "./box-intent";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration } from "./declaration";
import { intentGraph } from "./intent";
import { parseFrontMatter } from "./records";
import { workspaceStatus, type StatusDocument } from "./status";
import statusSchema from "./status.schema.json";

afterAll(cleanScratch);

const REF = join(REPO, "reference-workspace", "decisions");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value as Record<string, unknown>;
})();

const QUESTION = "What is this box for?";
const CHOICE = { option: "a", reason: "The person who planted the box answered it." };
const ANSWER = "a chant project with the docker lexicon";

/** A decision record from ref-001: proposed with no choice, or decided by alex. JSON is YAML, so the front matter is JSON. */
function decision(id: string, state: "proposed" | "decided", constrains: string[]): string {
  const data = {
    ...BASE,
    id,
    title: `Intent ${id}`,
    state,
    question: QUESTION,
    choice: state === "decided" ? CHOICE : null,
    rejected: [],
    evidence: [],
    decided_by: state === "decided" ? "alex" : null,
    decided_on: state === "decided" ? "2026-09-26" : null,
    constrains,
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function workspace(box: Record<string, unknown>, records: Record<string, string>, declareKind = true): string {
  return repo({
    "chant.workspace.json": JSON.stringify(
      {
        name: "acme",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "the box", box }],
        ...(declareKind ? { records: [{ kind: "decisions/decision.kind.mjs" }] } : {}),
      },
      null,
      2,
    ),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decision.schema.json"), "utf-8"),
    ...records,
  });
}

const intentFindings = async (root: string) =>
  (await runDeclarationChecks(root)).diagnostics.filter((d) => d.ruleId === "WSP126" || d.ruleId === "WSP127").map((d) => [d.ruleId, d.severity, d.code, d.entity]);

const status = contract(statusSchema);
async function boxOf(root: string) {
  const doc: StatusDocument = await workspaceStatus({ cwd: root, env: "prod" });
  if ("error" in doc) throw new Error(doc.error.message);
  status.expectValid(doc);
  return doc.members[0].box;
}

describe("the box block's intent", () => {
  test("is parsed into the box declaration, and is null when the block names none", () => {
    const parse = (box: unknown) =>
      parseDeclaration(JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x", box }] }), "chant.workspace.json").members[0].box;
    expect(parse({ intent: "box-001" })?.intent).toBe("box-001");
    expect(parse({})?.intent).toBeNull();
  });

  test("covers the box through member:, or a path: at, above or inside its directory", () => {
    const m = { name: "app", dir: "apps/app" };
    expect(["member:app", "path:apps/app", "path:apps", "path:apps/app/server.mjs"].map((c) => constrainsBox(c, m))).toEqual([true, true, true, true]);
    expect(["member:web", "path:apps/application", "path:web", "issue:1"].map((c) => constrainsBox(c, m))).toEqual([false, false, false, false]);
  });
});

describe("a box planted as a question", () => {
  test("a proposed intent reports its question and no answer, and passes the checks", async () => {
    const root = workspace({ intent: "box-001" }, { "decisions/box-001-what-app-is-for.md": decision("box-001", "proposed", ["member:app"]) });
    expect((await boxOf(root))?.intent).toEqual({ id: "box-001", state: "proposed", question: QUESTION, choice: null, answer: null, decided_by: null, decided_on: null });
    expect(await intentFindings(root)).toEqual([]);
  });

  test("a decided intent reports the answer and who gave it, and graph --intent shows it for the box's files", async () => {
    const root = workspace({ intent: "box-001" }, { "decisions/box-001-what-app-is-for.md": decision("box-001", "decided", ["member:app"]) });
    expect((await boxOf(root))?.intent).toEqual({ id: "box-001", state: "decided", question: QUESTION, choice: CHOICE, answer: ANSWER, decided_by: "alex", decided_on: "2026-09-26" });
    expect(await intentFindings(root)).toEqual([]);
    commitAll(root, "plant the box");
    const { doc } = await intentGraph({ cwd: root, region: "app" });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.nodes.filter((n) => n.kind === "decision").map((n) => (n.kind === "decision" ? [n.record, n.state, n.decided_by] : []))).toEqual([["box-001", "decided", "alex"]]);
  });

  test("a decided intent whose choice names an option not in options[] reports a null answer", async () => {
    const data = { ...BASE, id: "box-001", title: "Intent box-001", state: "decided", question: QUESTION, choice: { option: "z", reason: "no such option" }, rejected: [], evidence: [], decided_by: "alex", decided_on: "2026-09-26", constrains: ["member:app"] };
    const record = `---\n${JSON.stringify(data, null, 2)}\n---\n\n# box-001\n`;
    const root = workspace({ intent: "box-001" }, { "decisions/box-001-what-app-is-for.md": record });
    expect((await boxOf(root))?.intent?.answer).toBeNull();
  });

  test("an intent no decision record has fails WSP126, and status reports only its id", async () => {
    const root = workspace({ intent: "box-009" }, { "decisions/box-001-what-app-is-for.md": decision("box-001", "proposed", ["member:app"]) });
    expect((await boxOf(root))?.intent).toEqual({ id: "box-009", state: null, question: null, choice: null, answer: null, decided_by: null, decided_on: null });
    expect(await intentFindings(root)).toEqual([["WSP126", "error", "box-intent-unknown", "app"]]);
    const [d] = (await runDeclarationChecks(root)).diagnostics.filter((x) => x.ruleId === "WSP126");
    expect(d.message).toContain("no record of decisions/decision.kind.mjs has that id");
  });

  test("an intent in a workspace that declares no decision kind fails WSP126", async () => {
    const root = workspace({ intent: "box-001" }, {}, false);
    const [d] = (await runDeclarationChecks(root)).diagnostics.filter((x) => x.ruleId === "WSP126");
    expect(d.message).toContain("the declaration names no record kind called decision");
  });

  test("an intent that constrains nothing of the box warns WSP127", async () => {
    const root = workspace({ intent: "box-001" }, { "decisions/box-001-what-app-is-for.md": decision("box-001", "proposed", ["path:docs"]) });
    expect(await intentFindings(root)).toEqual([["WSP127", "warning", "box-intent-unconstrained", "app"]]);
  });

  test("a box with no intent reports null", async () => {
    const root = workspace({ capabilities: [] }, {});
    expect((await boxOf(root))?.intent).toBeNull();
    expect(await intentFindings(root)).toEqual([]);
  });
});
