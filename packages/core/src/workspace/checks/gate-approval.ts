/**
 * WSP153 (#4404): an Op gate's `approval` block that `identity.gates` does
 * not back at base.
 *
 * A run reads a gate's `quorum`, `policy`, `mode` and `context` from
 * `identity.gates.<gate>` in the declaration at base (#4324, #4404). A field
 * the entry leaves out is read from the Op being run, which the change under
 * review can edit, so a pull request can lower a quorum or switch a policy to
 * `log-only` and be judged by its own edit. The Op-side fallback stays so an
 * existing Op does not drop to one approval overnight. This check names each
 * gate that still leans on it, and the fields it leans on.
 *
 * It reads each member's built Ops (`dist/ops/<name>/op.json`) and runs
 * nothing. An Op that has not been built is not seen.
 */

import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";
import { joinPath } from "../tree";
import { read } from "./security";

export const WSP_GATE_APPROVAL_UNBASED = "WSP153";

/** The finding code WSP153 reports. */
export const GATE_APPROVAL_FINDING_CODES = ["gate-approval-unbased"] as const;

const memberDir = (dir: string) => (dir === "." ? "" : dir);

type Fields = "quorum" | "policy" | "mode" | "context";

interface GateUse {
  gate: string;
  /** What the Op's `approval` block sets. Context is the keys it sets. */
  quorum: boolean;
  policy: boolean;
  mode: boolean;
  context: string[];
}

interface StepJson {
  kind?: string;
  gate?: string;
  signalName?: string;
  approval?: { quorum?: unknown; policy?: unknown; mode?: unknown; context?: Record<string, unknown> };
  steps?: StepJson[];
}

/** The gates of a built Op that declare an `approval` block, with the fields it sets. A gate that asks a decision point has none. */
export function gateUses(op: { phases?: { steps?: StepJson[] }[]; onFailure?: { steps?: StepJson[] }[] }): GateUse[] {
  const out: GateUse[] = [];
  const visit = (step: StepJson): void => {
    if (step.kind === "gate" && step.approval && typeof step.approval === "object") {
      const a = step.approval;
      out.push({
        gate: step.gate ?? step.signalName ?? "",
        quorum: a.quorum !== undefined,
        policy: a.policy !== undefined,
        mode: a.mode !== undefined,
        context: a.context && typeof a.context === "object" ? Object.keys(a.context) : [],
      });
    }
    if (step.kind === "effect") (step.steps ?? []).forEach(visit);
  };
  for (const p of [...(op.phases ?? []), ...(op.onFailure ?? [])]) (p.steps ?? []).forEach(visit);
  return out;
}

/** The fields of `use` that `entry` (the gate's `identity.gates` entry, or undefined) does not set, as phrases. Empty when base backs every one. */
export function unbasedFields(use: GateUse, entry: { quorum: unknown; policy: unknown; mode: unknown; context: Record<string, unknown> | null } | undefined): string[] {
  const out: string[] = [];
  const has = (f: Exclude<Fields, "context">): boolean => entry?.[f] !== null && entry?.[f] !== undefined;
  for (const f of ["quorum", "policy", "mode"] as const) if (use[f] && !has(f)) out.push(f);
  const loose = use.context.filter((k) => !(k in (entry?.context ?? {})));
  if (loose.length > 0) out.push(`context (${loose.join(", ")})`);
  return out;
}

export const GATE_APPROVAL_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_GATE_APPROVAL_UNBASED,
    name: "gate-approval-unbased",
    description: "An Op gate declares an approval block whose quorum, policy, mode or context identity.gates does not set at base, so the change being run can edit it.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      const gates = ctx.declaration.identity?.gates ?? {};
      for (const member of ctx.declaration.members) {
        const opsDir = joinPath(memberDir(member.dir), "dist", "ops");
        for (const entry of ctx.tree.list(opsDir) ?? []) {
          if (entry.type !== "dir") continue;
          const path = joinPath(opsDir, entry.name, "op.json");
          const text = read(ctx.tree, path);
          if (text === null) continue;
          let op: Parameters<typeof gateUses>[0] & { name?: string };
          try {
            op = JSON.parse(text);
          } catch {
            continue;
          }
          for (const use of gateUses(op)) {
            const base = gates[use.gate];
            const missing = unbasedFields(use, base);
            if (missing.length === 0) continue;
            out.push({
              checkId: this.id,
              severity: this.severity,
              code: GATE_APPROVAL_FINDING_CODES[0],
              message: `WSP153: gate "${use.gate}" in Op ${op.name ?? entry.name} sets ${missing.join(", ")} in its approval block, and ${base ? `identity.gates.${use.gate}` : "identity.gates"} sets ${base ? "none of them" : `no entry for it`} at base, so a change can edit ${missing.length === 1 ? "it" : "them"} for its own run; declare ${base ? "them" : `identity.gates.${use.gate}`} in chant.workspace.json`,
              pointer: base ? base.pointer : "/identity",
              entity: use.gate,
              treeFile: path,
              line: 1,
              column: 1,
            });
          }
        }
      }
      return out;
    },
  },
];
