/**
 * OPS019: workspace-op-target (#2554, #2524 D17, ws-030). The design named
 * this check OPS014; that id was already the ConvergeOp rule-table refusal,
 * so it took the next free one.
 *
 * `chant workspace run` names its work as `<member>/<op>` targets. Before
 * anything runs, every target is checked against the composed graph: each
 * member's root, read under that member's own toolchain, with its Ops among
 * its entities. A target fails when its member is not in the graph (not a
 * `chant` member, or its read failed) or when the member declares no Op of
 * that name.
 *
 * It is a {@link CrossRootCheck} (#1939), so only `runCrossRootChecks` runs
 * it, and `chant build`, `chant lint` and a plain project never do.
 */
import type { CrossRootCheck, PostSynthDiagnostic } from "../../post-synth";
import { isOpEntity } from "./support";

export const OPS019_ID = "OPS019";

/** One `<member>/<op>` target. */
export interface WorkspaceOpTarget {
  member: string;
  op: string;
}

/**
 * Split `<member>/<op>` at its first `/`. A member name has no `/` (the
 * declaration's name pattern rules it out). Returns null for a string with no
 * `/`, or an empty member or op.
 */
export function parseWorkspaceOpTarget(text: string): WorkspaceOpTarget | null {
  const at = text.indexOf("/");
  if (at <= 0 || at === text.length - 1) return null;
  return { member: text.slice(0, at), op: text.slice(at + 1) };
}

export const formatWorkspaceOpTarget = (t: WorkspaceOpTarget): string => `${t.member}/${t.op}`;

function opName(entity: unknown): string | undefined {
  const props = (entity as { props?: { name?: unknown } } | null)?.props;
  return typeof props?.name === "string" ? props.name : undefined;
}

/** The OPS019 check over `targets`. */
export function ops019Check(targets: readonly WorkspaceOpTarget[]): CrossRootCheck {
  return {
    id: OPS019_ID,
    description: "A workspace Op target names a member in the composed graph and an Op that member declares",
    scope: "cross-root",
    check(ctx) {
      const diagnostics: PostSynthDiagnostic[] = [];
      const opsByRoot = new Map<string, Set<string>>();
      for (const e of ctx.entities) {
        if (!isOpEntity(e.entity)) continue;
        const name = opName(e.entity) ?? e.name;
        const set = opsByRoot.get(e.root) ?? new Set<string>();
        set.add(name);
        opsByRoot.set(e.root, set);
      }
      for (const t of targets) {
        const target = formatWorkspaceOpTarget(t);
        if (!ctx.root(t.member)) {
          diagnostics.push({
            checkId: OPS019_ID,
            severity: "error",
            message: `${target}: member "${t.member}" is not in the composed graph. A workspace Op runs in a chant member whose graph could be read.`,
            missing: { kind: "member", scope: t.member },
          });
          continue;
        }
        const ops = opsByRoot.get(t.member) ?? new Set<string>();
        if (!ops.has(t.op)) {
          const known = [...ops].sort();
          diagnostics.push({
            checkId: OPS019_ID,
            severity: "error",
            message:
              `${target}: member "${t.member}" declares no Op named "${t.op}". ` +
              (known.length > 0 ? `Its Ops: ${known.join(", ")}.` : "It declares no Ops."),
            root: t.member,
            missing: { kind: "op", scope: t.member },
          });
        }
      }
      return diagnostics;
    },
  };
}
