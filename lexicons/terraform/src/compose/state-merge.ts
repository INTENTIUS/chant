/**
 * The working state of a composed run (chant#4442, epic #4419): each
 * member's pulled state moved under `module.<m>` in one state the composed
 * root plans and applies against, and, once the apply is done or has failed,
 * split back into one state per member by module address.
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (`mergeStates`, `splitState`) and `migrate.ts` (`derivedLineage`), with
 * chant's {@link Composition} in place of terragucci's: members are
 * components, and a member's directory is `Composition.dirs`. Pulling and
 * writing the states is `../state` (#4437).
 *
 * The lineage and serial rules are terragucci's: a split state keeps its
 * pulled lineage and takes the pulled serial plus one; a member with no
 * state yet gets a lineage derived from the composed run and its root, and
 * serial 1. The working state itself has serial 1 and a lineage derived from
 * the members in order.
 */

import { createHash } from "node:crypto";
import type { Composition } from "../compose";
import type { StateFile, StateResource } from "../state/exec";
import { rootTexts } from "./hcl";
import { inModule, stripModule } from "./module-address";

/** What the derived lineages are derived from, beside the roots. */
export const COMPOSE_LINEAGE = "chant terraform.compose";

/** A lineage in the form Terraform writes (a version 4 UUID), derived from `parts`, so the same parts always give the same lineage. */
export function derivedLineage(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Whether a root's own files configure the provider of type `type` (a `provider "<type>"` block): its resources then name the module's configuration. */
function ownsProvider(dir: string | undefined, type: string): boolean {
  if (!dir) return false;
  return rootTexts(dir).some((t) => (t.json ? new RegExp(`"provider"\\s*:\\s*\\{[^]*"${type}"`).test(t.text) : new RegExp(`\\bprovider\\s+"${type}"\\s*\\{`).test(t.text)));
}

function versionAbove(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The members whose state the working state holds, in apply order. */
type StateComposition = Pick<Composition, "order" | "modules" | "dirs"> & Partial<Pick<Composition, "roots">>;

/**
 * The working state: each member's resources with `module.<m>` in front of
 * their module, each output as `<m>__<name>` (the composed root's outputs, so
 * an output that does not change plans no change), check results left out.
 * A resource whose root configures its provider itself names the module's
 * provider configuration. `pulled` is by member; a member with no state
 * (null or absent) adds nothing. The highest `terraform_version` pulled wins.
 */
export function mergeStates(c: StateComposition, pulled: ReadonlyMap<string, StateFile | null>): StateFile {
  const resources: StateResource[] = [];
  const outputs: Record<string, unknown> = {};
  let tfVersion: string | undefined;
  for (const member of c.order) {
    const s = pulled.get(member);
    if (!s) continue;
    const m = c.modules.get(member)!;
    if (s.terraform_version && (!tfVersion || versionAbove(s.terraform_version, tfVersion))) tfVersion = s.terraform_version;
    for (const res of s.resources) {
      const provider = typeof res.provider === "string" ? res.provider : undefined;
      const type = provider?.match(/provider\["([^"]+)"\]/)?.[1]?.split("/").pop();
      const own = provider && type && !provider.startsWith("module.") && ownsProvider(c.dirs.get(member), type);
      resources.push({
        ...structuredClone(res),
        module: res.module ? `module.${m}.${res.module}` : `module.${m}`,
        ...(provider ? { provider: own || provider.startsWith("module.") ? `module.${m}.${provider}` : provider } : {}),
      });
    }
    for (const [k, v] of Object.entries(s.outputs ?? {})) outputs[`${m}__${k}`] = structuredClone(v);
  }
  return { version: 4, terraform_version: tfVersion ?? "1.0.0", serial: 1, lineage: derivedLineage(COMPOSE_LINEAGE, ...c.order), outputs, resources, check_results: null };
}

/** JSON with every object's keys sorted, so two objects that differ only in key order print the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * A state's resources and outputs in one order, for comparing two states.
 * Keys are sorted too: a split resource in a nested module carries `module`
 * after its other keys, where `state pull` prints it first.
 */
const canonical = (s: Pick<StateFile, "resources" | "outputs">): string =>
  JSON.stringify({
    resources: [...s.resources].map(stable).sort(),
    outputs: stable(s.outputs ?? {}),
  });

/** One member's state out of the working state, and whether it holds what was pulled. */
export interface SplitState {
  state: StateFile;
  /** It holds what was pulled (for a member with no state: nothing), so there is nothing to write. */
  same: boolean;
}

/**
 * One member's state out of the working state: its resources with the module
 * taken off, its outputs from `<m>__*`, its pulled lineage and its pulled
 * serial plus one (a member with no state yet gets a lineage of its own,
 * derived from its root, and serial 1). `same` when it holds what was pulled.
 */
export function splitState(working: StateFile, c: StateComposition, member: string, pulled: StateFile | null): SplitState {
  const m = c.modules.get(member)!;
  const resources: StateResource[] = [];
  for (const res of working.resources) {
    if (!inModule(res.module, m)) continue;
    const module = res.module === `module.${m}` ? undefined : stripModule(res.module!);
    const { module: _m, ...rest } = structuredClone(res);
    const provider = typeof rest.provider === "string" && inModule(rest.provider, m) ? stripModule(rest.provider) : rest.provider;
    resources.push({ ...rest, ...(module ? { module } : {}), ...(provider !== undefined ? { provider } : {}) });
  }
  const outputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(working.outputs ?? {})) if (k.startsWith(`${m}__`)) outputs[k.slice(m.length + 2)] = v;
  const state: StateFile = {
    version: 4,
    terraform_version: working.terraform_version,
    serial: (pulled?.serial ?? 0) + 1,
    lineage: pulled?.lineage || derivedLineage(COMPOSE_LINEAGE, c.roots?.get(member) ?? member),
    outputs,
    resources,
    check_results: null,
  };
  const same = pulled ? canonical(state) === canonical(pulled) : resources.length === 0 && Object.keys(outputs).length === 0;
  return { state, same };
}

/** Every member's split state, by member, in apply order. */
export function splitStates(working: StateFile, c: StateComposition, pulled: ReadonlyMap<string, StateFile | null>): Map<string, SplitState> {
  return new Map(c.order.map((member) => [member, splitState(working, c, member, pulled.get(member) ?? null)] as const));
}
