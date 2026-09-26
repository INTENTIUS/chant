/**
 * The diagram checks, WSP131 to WSP133 (#2764).
 *
 * A declared diagram names a source and a render, pinned to the renderer
 * its render was made with. chant never runs a renderer (ws-052), on a read
 * path or here: these checks read the declaration and the tree checked
 * only, and a render's drift is caught by comparing a recorded content hash,
 * never by re-rendering the source.
 *
 * | Id | Code | Fails when |
 * |---|---|---|
 * | WSP131 | `diagram-source-missing` | a diagram names a source, and it does not exist in the tree read |
 * | WSP132 | `diagram-render-missing` | a diagram's render does not exist in the tree read |
 * | WSP133 | `diagram-render-drift` | a diagram records a `sourceHash`, and the source's bytes now hash to something else |
 *
 * WSP133 is opt-in per diagram: without a recorded `sourceHash` there is
 * nothing to compare, so the entry is silently not checked for drift. A
 * declaration records one by hashing the source when it commits a fresh
 * render, the way a decision's evidence pins a file by hash
 * (`../record-assets.ts`). Comparing that one recorded hash against the
 * source in the tree read is cheap and deterministic, unlike shelling out to
 * the pinned renderer and diffing its output, which chant does nowhere.
 */

import { sha256Hex } from "../../content-digest";
import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import { declaredDiagrams, type DiagramDeclaration } from "../declaration";
import type { ReasonCode } from "../reason-codes";

/** The read contract's codes for the diagram findings, carried as `code` on each. */
export const DIAGRAM_FINDING_CODES = ["diagram-source-missing", "diagram-render-missing", "diagram-render-drift"] as const satisfies readonly ReasonCode[];

export const WSP_DIAGRAM_SOURCE_MISSING = "WSP131";
export const WSP_DIAGRAM_RENDER_MISSING = "WSP132";
export const WSP_DIAGRAM_RENDER_DRIFT = "WSP133";

const where = (d: DiagramDeclaration) => (d.member === null ? "the workspace's own" : `member ${d.member}'s`);

function diagramFinding(check: WorkspaceCheck, d: DiagramDeclaration, field: "source" | "render" | "sourceHash", code: (typeof DIAGRAM_FINDING_CODES)[number], message: string): WorkspaceDiagnostic {
  return {
    checkId: check.id,
    severity: check.severity,
    code,
    message: `${code}: ${message}`,
    entity: d.member ?? undefined,
    pointer: `${d.pointer}/${field}`,
  };
}

export const DIAGRAM_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_DIAGRAM_SOURCE_MISSING,
    name: "diagram-source-missing",
    description: "A diagram's source file, when it names one, exists in the tree read.",
    severity: "error",
    configurable: true,
    check(ctx: WorkspaceCheckContext) {
      const out: WorkspaceDiagnostic[] = [];
      for (const d of declaredDiagrams(ctx.declaration)) {
        if (d.source === null || ctx.tree.stat(d.source) === "file") continue;
        out.push(diagramFinding(this, d, "source", "diagram-source-missing", `${where(d)} diagram ${d.name} names the source ${d.source}, which does not exist${ctx.tree.label}`));
      }
      return out;
    },
  },
  {
    id: WSP_DIAGRAM_RENDER_MISSING,
    name: "diagram-render-missing",
    description: "A diagram's render exists in the tree read.",
    severity: "error",
    configurable: true,
    check(ctx: WorkspaceCheckContext) {
      const out: WorkspaceDiagnostic[] = [];
      for (const d of declaredDiagrams(ctx.declaration)) {
        if (ctx.tree.stat(d.render) === "file") continue;
        out.push(diagramFinding(this, d, "render", "diagram-render-missing", `${where(d)} diagram ${d.name} names the render ${d.render}, which does not exist${ctx.tree.label}`));
      }
      return out;
    },
  },
  {
    id: WSP_DIAGRAM_RENDER_DRIFT,
    name: "diagram-render-drift",
    description: "A diagram that records a sourceHash is unchanged since its render was made: the source's bytes still hash to it. Runs no renderer.",
    severity: "error",
    configurable: true,
    check(ctx: WorkspaceCheckContext) {
      const out: WorkspaceDiagnostic[] = [];
      for (const d of declaredDiagrams(ctx.declaration)) {
        if (d.sourceHash === null || d.source === null) continue;
        if (ctx.tree.stat(d.source) !== "file") continue; // diagram-source-missing already reports it
        const bytes = ctx.tree.bytes ? ctx.tree.bytes(d.source) : Buffer.from(ctx.tree.read(d.source), "utf-8");
        const actual = sha256Hex(bytes);
        if (actual === d.sourceHash) continue;
        out.push(
          diagramFinding(
            this,
            d,
            "sourceHash",
            "diagram-render-drift",
            `${where(d)} diagram ${d.name}'s source ${d.source} changed since ${d.render} was rendered from it: recorded sourceHash ${d.sourceHash.slice(0, 12)} does not match the source's current hash ${actual.slice(0, 12)}${ctx.tree.label}; rerun the renderer and commit the result, or update sourceHash`,
          ),
        );
      }
      return out;
    },
  },
];
