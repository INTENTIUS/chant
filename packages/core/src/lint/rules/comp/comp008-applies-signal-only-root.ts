/**
 * COMP008: applies-signal-only-root (#4490)
 *
 * Flags a component whose `terraform-apply` step deploys a root the project
 * marks `signalOnly: true` in `terraform.roots` (#4484). Such a root belongs
 * to another workspace member and is declared here only so a change to it
 * brings this project into the change: the build skips it, so this
 * project's graph does not draw it, and the live reads skip it too. A
 * component that applies it would apply a root chant otherwise treats as
 * the other member's, so the warning names the root and the member that
 * owns it (the workspace member whose directory holds the root's `dir`).
 *
 * The roots come from the project's chant config, resolved by `chant lint`
 * ({@link signalOnlyRootsOf}) and handed to the check on
 * `ComponentCheckContext.signalOnlyRoots`. A check run without them (a
 * direct unit test, a project with no terraform roots) flags nothing.
 *
 * Triggers on: `{ kind: "terraform-apply", root: "azure" }` where
 * `terraform.roots.azure.signalOnly` is `true`.
 * OK: the same step on a root without the marker, or no `terraform-apply`
 * step naming the marked root.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic, SignalOnlyRoot } from "../../component-checks";
import { walkComponent } from "./support";

export const comp008AppliesSignalOnlyRootRule: ComponentCheck = {
  id: "COMP008",
  severity: "warning",
  category: "correctness",
  description: "A terraform-apply step deploys a root marked signalOnly, which another workspace member owns",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const roots = ctx.signalOnlyRoots;
    if (!roots || roots.size === 0) return [];
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      const seen = new Set<string>();
      for (const { step, phaseName } of walkComponent(component).steps) {
        if (step.kind !== "terraform-apply") continue;
        const root = (step as { root?: unknown }).root;
        if (typeof root !== "string" || seen.has(root)) continue;
        const marked = roots.get(root);
        if (!marked) continue;
        seen.add(root);
        const owner = marked.owner
          ? `workspace member "${marked.owner}" owns it`
          : "no workspace member was found to own it";
        diagnostics.push({
          checkId: "COMP008",
          severity: "warning",
          component: name,
          file: filePath,
          message:
            `Component "${name}": the "terraform-apply" step (phase "${phaseName}") deploys root "${root}" ` +
            `(${marked.dir}), which terraform.roots marks signalOnly; ${owner}. This project declares the root ` +
            `only so a change to it brings the project into the change, and its build and live reads skip it. ` +
            `Deploy the root from ${marked.owner ? `"${marked.owner}"` : "the member that owns it"}, or drop signalOnly ` +
            `if this project owns it.`,
        });
      }
    }

    return diagnostics;
  },
};

/**
 * The roots a project's `terraform.roots` marks `signalOnly`, keyed by root
 * name, each with its `dir` as written and the workspace member whose
 * directory holds it. `projectDir` is the directory holding the chant
 * config. Tolerant: a config that does not load, or no marked root, gives an
 * empty map; a workspace declaration that does not read leaves `owner` off.
 */
export async function signalOnlyRootsOf(projectDir: string): Promise<Map<string, SignalOnlyRoot>> {
  const out = new Map<string, SignalOnlyRoot>();
  let roots: Record<string, unknown> | undefined;
  try {
    const { loadChantConfig } = await import("../../../config");
    const loaded = await loadChantConfig(projectDir);
    roots = (loaded.config as { terraform?: { roots?: Record<string, unknown> } }).terraform?.roots;
  } catch {
    return out;
  }
  const marked: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(roots ?? {})) {
    if (typeof entry !== "object" || entry === null) continue;
    const { dir, signalOnly } = entry as { dir?: unknown; signalOnly?: unknown };
    if (signalOnly !== true || typeof dir !== "string") continue;
    marked.push([name, dir]);
  }
  if (marked.length === 0) return out;

  const ownerOfDir = await workspaceOwnerLookup(projectDir);
  for (const [name, dir] of marked) {
    const owner = ownerOfDir?.(resolve(projectDir, dir));
    out.set(name, { dir, ...(owner ? { owner } : {}) });
  }
  return out;
}

/** A lookup from an absolute directory to the workspace member owning it, or undefined outside a readable workspace. */
async function workspaceOwnerLookup(projectDir: string): Promise<((abs: string) => string | undefined) | undefined> {
  try {
    const { findWorkspaceRoot } = await import("../../../project-root");
    const found = findWorkspaceRoot(projectDir);
    if (!found) return undefined;
    const { readDeclaration, ownerOf } = await import("../../../workspace/declaration");
    const { workingTree } = await import("../../../workspace/tree");
    const declaration = readDeclaration(workingTree(found.dir));
    return (abs: string) => {
      const rel = relative(found.dir, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
      const owner = ownerOf(declaration, [], rel === "" ? "." : rel.split("\\").join("/"));
      return owner && "member" in owner ? owner.member.name : undefined;
    };
  } catch {
    return undefined;
  }
}
