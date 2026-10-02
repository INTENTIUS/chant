/**
 * `chud-lexicon-exit-ship-policy` (#2810): let a person pass the ship gate
 * in a repo `chud-lexicon-exit` migrated.
 *
 * `chud-lexicon-exit` (0.92.0) kept chud's decisions/ship-skip.cedar.ts,
 * which permits an agent when the ship-skip table said yes and permits no
 * person. Cedar denies what nothing permits, so it decided `deny` on a
 * person's approval too, and only `log-only` let one through. This migration
 * adds a permit for `Chant::Human` under the same floor, which still forbids
 * an agent unless the table said yes. At `enforce`, Cedar then decides
 * `allow` for a person and `deny` for an agent.
 *
 * The plan is empty unless the policy is the one `chud-lexicon-exit` left
 * (it reads the decide step's `shipSkipBy`), and once the permit is there. A
 * policy the project changed so that an anchor is gone is a conflict.
 */

import { posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, PlanConflict, PlannedChange } from "../chant-migrations";
import { applyEdits, readText, type Edit } from "./chud-lexicon-exit";

export const CHUD_LEXICON_EXIT_SHIP_POLICY = "chud-lexicon-exit-ship-policy";

const DESCRIPTION = "let a person pass the ship gate: the Cedar policy chud-lexicon-exit kept permits no person (#2810)";

/** The policy `chud-lexicon-exit` left: chud's, reading the decide step's answer and decider. */
function isExitPolicy(text: string): boolean {
  return text.includes('context.shipSkipBy == "table"') && text.includes("agentSkipsOnTableYes") && !/export const personApproves\b/.test(text);
}

export const SHIP_POLICY_EDITS: Edit[] = [
  {
    find: `import { DenyByDefaultSet, Policy, gatePolicy, GATE_AGENT_TYPE, PASS_GATE_ACTION } from "@intentius/chant-lexicon-cedar";`,
    replace: `import { DenyByDefaultSet, Policy, gatePolicy, GATE_AGENT_TYPE, GATE_HUMAN_TYPE, PASS_GATE_ACTION } from "@intentius/chant-lexicon-cedar";`,
    required: "the import from @intentius/chant-lexicon-cedar",
    unless: /GATE_HUMAN_TYPE/,
  },
  {
    find: "const agent = GATE_AGENT_TYPE as never;\n",
    replace: "const person = GATE_HUMAN_TYPE as never;\nconst agent = GATE_AGENT_TYPE as never;\n",
    required: "the `agent` principal type",
    unless: /const person = GATE_HUMAN_TYPE/,
  },
  {
    find: "export const agentSkipsOnTableYes = new Policy({",
    replace: `/** A person may pass the gate: it is where a person approves the release. */
export const personApproves = new Policy({
  effect: "permit",
  principal: { is: person },
  action: { eq: passGate },
  annotations: { id: "a-person-approves" },
});

export const agentSkipsOnTableYes = new Policy({`,
    required: "the agentSkipsOnTableYes policy",
  },
  {
    find: "  policies: [agentSkipsOnTableYes],\n",
    replace: "  policies: [personApproves, agentSkipsOnTableYes],\n",
    required: "the DenyByDefaultSet's `policies`",
  },
  {
    find: " * The rule: an agent may pass the gate only when the decision table said yes.\n",
    replace: " * The rule: a person may always pass the gate, and an agent only when the\n * decision table said yes.\n",
  },
  {
    find: " * every release until someone adds a row, so by default a person always\n * approves.\n",
    replace: " * every release until someone adds a row, so by default a person always\n * approves. In `enforce` mode Cedar decides `allow` on a person's approval\n * and `deny` on an agent's.\n",
  },
];

interface Declaration {
  members?: Array<{ dir?: string; kind?: string }>;
}

function planShipPolicy(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const candidates = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (!candidates.includes("delivery")) candidates.push("delivery");

  const changes: PlannedChange[] = [];
  const conflicts: PlanConflict[] = [];
  for (const d of candidates) {
    const path = posix.join(d, "decisions/ship-skip.cedar.ts");
    const text = readText(dir, path);
    if (text === undefined || !isExitPolicy(text)) continue;
    const edited = applyEdits(text, SHIP_POLICY_EDITS);
    if (edited.missing.length > 0) {
      conflicts.push({ path, reason: `cannot find ${edited.missing.join("; ")}. Add a permit for Chant::Human by hand, then run the upgrade again` });
      continue;
    }
    changes.push({ path, action: "write", why: "a person may pass the ship gate; an agent only when the table said yes", data: Buffer.from(edited.text) });
  }
  if (changes.length === 0 && conflicts.length === 0) return null;
  return { id: CHUD_LEXICON_EXIT_SHIP_POLICY, description: DESCRIPTION, changes, notMoved: [], conflicts };
}

export const chudLexiconExitShipPolicy: ChantMigration = {
  id: CHUD_LEXICON_EXIT_SHIP_POLICY,
  description: DESCRIPTION,
  plan: planShipPolicy,
};
