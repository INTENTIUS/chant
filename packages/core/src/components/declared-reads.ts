/**
 * Reads a capability finds in the files its steps name (#4466).
 *
 * A read core can see is a `stackOutput()` or `@<component>.publish.*`
 * reference in a step. A CloudFormation template that imports another
 * stack's export reads that stack too, but the read sits inside the
 * template. A capability that can find such reads says so through
 * `Capability.declaredReads`, and {@link withDeclaredReads} writes each one
 * into the reader's step as the `stackOutput()` reference a person would have
 * written, plus a `dependsOn` on the upstream. From there on it is an ordinary
 * read: it orders the fan-out, it is named under `unknownInputs` while the
 * upstream's plan cannot say the value, and a reader whose plan read another
 * value than the upstream applied is held for a round.
 */

import type { CapabilityRegistry, DeclaredRead, DeclaredReadMember } from "./capability";
import type { DriverComponent, DriverPhase, DriverStep } from "./driver";
import { capabilitySteps } from "./wave-plan";

/** A declared read with the kind of the step it names. */
export type PlacedRead = DeclaredRead & { index: number; kind: string };

/** `pointer`'s segments, unescaped (RFC 6901). */
function segments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** `value` with `ref` placed at `path`, copying each object on the way; `undefined` when something already sits there. */
function placed(value: Record<string, unknown>, path: readonly string[], ref: unknown): Record<string, unknown> | undefined {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path as [string, ...string[]];
  const here = value[head];
  if (rest.length === 0) return here === undefined ? { ...value, [head]: ref } : undefined;
  if (here !== undefined && (here === null || typeof here !== "object" || Array.isArray(here))) return undefined;
  const inner = placed((here as Record<string, unknown> | undefined) ?? {}, rest, ref);
  return inner ? { ...value, [head]: inner } : undefined;
}

/** `phases` with each step `replace` gives a new value for swapped, in place, nested phases included. */
function mapSteps(phases: readonly DriverPhase[], replace: (step: DriverStep) => DriverStep): DriverPhase[] {
  const walk = (steps: DriverPhase["steps"]): DriverPhase["steps"] =>
    steps.map((step) => {
      if (typeof (step as DriverPhase).phase === "string" && Array.isArray((step as DriverPhase).steps)) {
        return { ...(step as DriverPhase), steps: walk((step as DriverPhase).steps) };
      }
      if ((step as { kind?: unknown }).kind === "gate") return step;
      return replace(step as DriverStep);
    }) as DriverPhase["steps"];
  return phases.map((phase) => ({ ...phase, steps: walk(phase.steps) }));
}

/**
 * Each capability's declared reads among `components` (#4466): every read a
 * capability with `declaredReads` reports between two components of the
 * project, its own reads of itself left out. A capability that throws
 * reports none.
 */
export async function declaredReadsOf(
  components: readonly DriverComponent[],
  registry: CapabilityRegistry,
  root: string,
): Promise<PlacedRead[]> {
  const names = new Set(components.map((c) => c.name));
  const byKind = new Map<string, DeclaredReadMember[]>();
  for (const component of components) {
    const seen = new Map<string, number>();
    for (const step of capabilitySteps(component.deploy)) {
      if (!registry.has(step.kind)) continue;
      const index = seen.get(step.kind) ?? 0;
      seen.set(step.kind, index + 1);
      const { kind, ...rest } = step;
      (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push({ component: component.name, index, step: rest });
    }
  }
  const out: PlacedRead[] = [];
  for (const [kind, members] of byKind) {
    const capability = registry.resolve(kind);
    if (typeof capability.declaredReads !== "function") continue;
    let reported: DeclaredRead[];
    try {
      reported = await capability.declaredReads({ root }, members);
    } catch {
      continue;
    }
    for (const r of reported ?? []) {
      if (r.reader === r.upstream || !names.has(r.reader) || !names.has(r.upstream)) continue;
      out.push({ ...r, index: r.index ?? 0, kind });
    }
  }
  return out.sort((a, b) => a.reader.localeCompare(b.reader) || a.index - b.index || a.at.localeCompare(b.at));
}

/**
 * `components` with each declared read written in (#4466): the reader's
 * step gets `{ stackOutput: { stack: upstream, name: output } }` at the
 * read's place, unless something sits there already, and the reader depends
 * on the upstream. Components no read names come back as they were.
 */
export function applyDeclaredReads(components: readonly DriverComponent[], reads: readonly PlacedRead[]): DriverComponent[] {
  const byReader = new Map<string, PlacedRead[]>();
  for (const r of reads) (byReader.get(r.reader) ?? byReader.set(r.reader, []).get(r.reader)!).push(r);
  return components.map((component) => {
    const mine = byReader.get(component.name);
    if (!mine) return component;
    const kinds = new Map<string, number>();
    const added = new Set<string>();
    const deploy = mapSteps(component.deploy, (step) => {
      const index = kinds.get(step.kind) ?? 0;
      kinds.set(step.kind, index + 1);
      let next: DriverStep = step;
      for (const r of mine.filter((x) => x.kind === step.kind && x.index === index)) {
        const { kind, ...rest } = next;
        const with_ = placed(rest, segments(r.at), { stackOutput: { stack: r.upstream, name: r.output } });
        if (!with_) continue;
        next = { kind, ...with_ } as DriverStep;
        added.add(r.upstream);
      }
      return next;
    });
    const dependsOn = [...(component.dependsOn ?? [])];
    for (const up of [...added].sort()) if (!dependsOn.includes(up)) dependsOn.push(up);
    return { ...component, dependsOn, deploy };
  });
}

/** {@link declaredReadsOf} and {@link applyDeclaredReads} in one: `components` with their declared reads written in. */
export async function withDeclaredReads(components: readonly DriverComponent[], registry: CapabilityRegistry, root: string): Promise<DriverComponent[]> {
  const reads = await declaredReadsOf(components, registry, root);
  return reads.length > 0 ? applyDeclaredReads(components, reads) : [...components];
}
