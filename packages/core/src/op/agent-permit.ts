/**
 * An agent's Cedar permit on an `enforce` gate (#5388).
 *
 * An agent's permit passes an Op gate with no person approving only when the
 * gate's `identity.gates.<gate>` entry at base sets `agentPassesAlone: true`.
 * Without it, the permit passes the gate beside a person's approval of the
 * same plan ({@link tallyGateApprovals} in `./gate.ts`). A pipeline stage
 * passes through its own gates, `<stage>`, `<stage>-skip`, `<stage>-urgent`,
 * `<stage>-rollback` and `<stage>-soak`, and `chant build` refuses the key on
 * an entry naming one of them, so a stage never passes on an agent alone.
 *
 * `chant build` reads the declaration and the member's built Ops through
 * {@link agentPermitBuildFindings}: a warning for each entry that sets the
 * key, a warning naming the key for each enforced gate whose policy permits an
 * agent and whose entry does not set it, and a refusal for a stage gate's
 * entry that sets it.
 */

import { NEXT_RELEASE } from "../release-floors";
import { AGENT_PASSES_ALONE_KEY } from "./gate-approval-base";
import { CHANGE_RISK_CONTEXT_KEY } from "../change-risk";

/**
 * The first chant whose agent permit passes an `enforce` Op gate alone only
 * under `identity.gates.<gate>.agentPassesAlone` (#5388), and otherwise only
 * beside a person's approval of the same plan; `chant build` warns while the
 * key is set, names it for each enforced gate whose policy permits an agent,
 * and refuses it on a pipeline stage's promote, skip, urgent, rollback or
 * soak gate.
 */
export const AGENT_PASSES_ALONE_FLOOR = NEXT_RELEASE;

/** The Cedar entity type of an agent principal, as the cedar lexicon's `GATE_AGENT_TYPE` spells it. */
const AGENT_PRINCIPAL = "Chant::Agent";

/** The gates a stage passes through, by name, each with the kind of gate it is. */
export function stageGateNames(stages: readonly { name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { name } of stages) {
    out.set(name, `stage ${name}'s promote gate`);
    out.set(`${name}-skip`, `stage ${name}'s skip gate`);
    out.set(`${name}-urgent`, `stage ${name}'s urgent gate`);
    out.set(`${name}-rollback`, `stage ${name}'s rollback gate`);
    out.set(`${name}-soak`, `stage ${name}'s soak gate`);
  }
  return out;
}

/** An `identity.gates` entry, as far as this module reads it. */
export interface AgentPermitGateEntry {
  policy?: { text?: unknown } | null;
  mode?: unknown;
  agentPassesAlone?: boolean | null;
}

/** A gate of a built Op (`dist/ops/<name>/op.json`), as far as this module reads it. */
export interface AgentPermitOpGate {
  op: string;
  gate: string;
  approval: { policy?: { text?: unknown } | null; mode?: unknown; risk?: unknown; context?: Record<string, unknown> | null };
}

interface StepJson {
  kind?: string;
  gate?: string;
  signalName?: string;
  approval?: AgentPermitOpGate["approval"];
  steps?: StepJson[];
}

/** The gates with an `approval` block in a built Op. */
export function opGatesWithApproval(op: { name?: string; phases?: { steps?: StepJson[] }[]; onFailure?: { steps?: StepJson[] }[] }, fallbackName = ""): AgentPermitOpGate[] {
  const out: AgentPermitOpGate[] = [];
  const visit = (step: StepJson): void => {
    if (step.kind === "gate" && step.approval && typeof step.approval === "object") {
      out.push({ op: op.name ?? fallbackName, gate: step.gate ?? step.signalName ?? "", approval: step.approval });
    }
    if (step.kind === "effect") (step.steps ?? []).forEach(visit);
  };
  for (const p of [...(op.phases ?? []), ...(op.onFailure ?? [])]) (p.steps ?? []).forEach(visit);
  return out;
}

/** What {@link agentPermitBuildFindings} found: warnings to print, and refusals that fail the build. */
export interface AgentPermitFindings {
  warnings: string[];
  refusals: string[];
}

/**
 * The build's findings for `agentPassesAlone` (#5388). `gates` is the
 * declaration's `identity.gates`, `ops` the member's built Op gates, and
 * `stages` the member's pipeline stages, empty without a pipeline. With
 * `ops`, an entry that sets the key is warned about when one of those Ops
 * uses its gate; without, every such entry is.
 */
export function agentPermitBuildFindings(input: {
  gates: Readonly<Record<string, AgentPermitGateEntry>>;
  ops?: readonly AgentPermitOpGate[];
  stages?: readonly { name: string }[];
}): AgentPermitFindings {
  const warnings: string[] = [];
  const refusals: string[] = [];
  const stageGates = stageGateNames(input.stages ?? []);
  // With the member's Ops given, warn for the gates they use; without, for every entry.
  const used = input.ops ? new Set(input.ops.map((o) => o.gate)) : undefined;
  for (const [gate, entry] of Object.entries(input.gates)) {
    if (entry.agentPassesAlone !== true) continue;
    const stage = stageGates.get(gate);
    if (stage) {
      refusals.push(
        `identity.gates.${gate}.${AGENT_PASSES_ALONE_KEY} is set, and ${gate} is ${stage}: a stage gate passes on a person's approval, so remove the key from this entry`,
      );
    } else if (!used || used.has(gate)) {
      warnings.push(
        `identity.gates.${gate}.${AGENT_PASSES_ALONE_KEY} is true: an agent's policy permit passes gate ${gate} in enforce mode with no person approving`,
      );
    }
  }
  for (const use of input.ops ?? []) {
    const entry = input.gates[use.gate];
    if (entry?.agentPassesAlone === true || stageGates.has(use.gate)) continue;
    const mode = entry?.mode ?? use.approval.mode;
    const policy = entry?.policy ?? use.approval.policy;
    const text = typeof policy?.text === "string" ? policy.text : "";
    if (mode !== "enforce" || !text.includes(AGENT_PRINCIPAL)) continue;
    // #5325: a permit that reads the change risk never counts from an agent, key or not.
    if (use.approval.risk !== undefined || text.includes(CHANGE_RISK_CONTEXT_KEY) || (use.approval.context && CHANGE_RISK_CONTEXT_KEY in use.approval.context)) continue;
    warnings.push(
      `gate ${use.gate} in Op ${use.op} enforces a policy that permits ${AGENT_PRINCIPAL}, and an agent's permit now passes it only beside a person's approval; ` +
        `to let the agent pass it alone, set "${AGENT_PASSES_ALONE_KEY}": true in identity.gates.${use.gate} in chant.workspace.json`,
    );
  }
  return { warnings, refusals };
}
