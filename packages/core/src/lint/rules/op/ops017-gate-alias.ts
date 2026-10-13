/**
 * OPS017: a gate's aliases (#3949) can stand. An alias admits approvals of
 * the plan a run planned, so the gate must bind a `plan`, and a gate that
 * asks a decision point takes none. An alias must not name a gate that still
 * exists in the build, or one approval would answer two gates, and two gates
 * must not claim one alias. When the workspace's `identity.gates` names an
 * alias, the new gate must be named too, with the alias's class, or
 * approvals that needed a seal would count without one.
 *
 * The identity rules come from the caller, as SYS010's decide backends do:
 * `chant build` and `chant lint` read them with
 * {@link workspaceIdentityGates}, which loads workspace code only when an Op
 * has aliases and the project sits in a workspace. Without them that part
 * is skipped.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import type { OpConfig } from "../../../op";
import { gateStepsOf, validateGateAliases } from "../../../op/gate-alias";
import { findWorkspaceRoot } from "../../../project-root";
import { isOpEntity } from "./support";

/** The Op configs among a build's entities, each with its entity key and lexicon. */
function opsOf(entities: Iterable<[string, unknown]>): Array<{ entityKey: string; lexicon?: string; config: OpConfig }> {
  const ops: Array<{ entityKey: string; lexicon?: string; config: OpConfig }> = [];
  for (const [entityKey, entity] of entities) {
    if (!isOpEntity(entity as never)) continue;
    const rec = entity as Record<string, unknown>;
    const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
    if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;
    ops.push({ entityKey, ...(typeof rec.lexicon === "string" ? { lexicon: rec.lexicon } : {}), config: props });
  }
  return ops;
}

const hasAliases = (ops: ReadonlyArray<{ config: OpConfig }>): boolean =>
  ops.some(({ config }) => gateStepsOf(config).some(({ step }) => step.aliases !== undefined));

/**
 * The gates the workspace around `projectDir` names under `identity.gates`,
 * each with its class (null for any signer), for OPS017. Undefined when no
 * Op among `entities` has aliases, outside a workspace, or when the
 * declaration can't be read, which `chant workspace check` reports. The
 * workspace modules load only past the first two checks, so a level-0
 * build loads none.
 */
export async function workspaceIdentityGates(
  projectDir: string,
  entities: Iterable<[string, unknown]>,
): Promise<Map<string, string | null> | undefined> {
  if (!hasAliases(opsOf(entities))) return undefined;
  const found = findWorkspaceRoot(projectDir);
  if (!found) return undefined;
  try {
    const { readDeclaration } = await import("../../../workspace/declaration");
    const { workingTree } = await import("../../../workspace/tree");
    const gates = readDeclaration(workingTree(found.dir)).identity?.gates ?? {};
    return new Map(Object.values(gates).map((g) => [g.gate, g.class]));
  } catch {
    return undefined;
  }
}

/** OPS017, judging `identity.gates` by `identityGates` when given. */
export function ops017Check(identityGates?: ReadonlyMap<string, string | null>): PostSynthCheck {
  return {
    id: "OPS017",
    description:
      "A gate's aliases need a plan and no decision point, must not name a gate that still exists or another gate's alias, and keep any identity.gates rule an alias had",

    check(ctx: PostSynthContext): PostSynthDiagnostic[] {
      const ops = opsOf(ctx.entities);
      if (!hasAliases(ops)) return [];
      const byName = new Map(ops.map((o) => [o.config.name, o]));
      return validateGateAliases(ops.map((o) => o.config), identityGates).map((issue) => {
        const op = byName.get(issue.opName);
        return {
          checkId: "OPS017",
          severity: "error",
          message: `Op "${issue.opName}", phase "${issue.phase}", gate:${issue.gate}: ${issue.message}`,
          ...(op ? { entity: op.entityKey } : {}),
          ...(op?.lexicon ? { lexicon: op.lexicon } : {}),
        };
      });
    },
  };
}

/** OPS017 without the workspace's identity rules. */
export const ops017: PostSynthCheck = ops017Check();
