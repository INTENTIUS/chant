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

import { NEXT_RELEASE } from "../release-floors";
import type { CapabilityRegistry, DeclaredRead, DeclaredReadMember, GraphRead } from "./capability";
import type { DriverComponent, DriverPhase, DriverStep } from "./driver";
import { capabilitySteps } from "./wave-plan";
import { componentForEnvironment, type StepEnvironmentOptions } from "./step-environments";

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
  /**
   * The run's environment (#5360): each step is read with its
   * `environments` entry for it, so a stack or root that sits only in the
   * map is the one the capability reads. A step that does not name it is
   * read as declared.
   */
  environment?: { env: string } & StepEnvironmentOptions,
): Promise<PlacedRead[]> {
  if (environment) components = components.map((c) => componentForEnvironment(c, environment.env, environment).component);
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

/**
 * {@link declaredReadsOf} and {@link applyDeclaredReads} in one: `components`
 * with their declared reads written in. With `environment`, the components
 * come back resolved for it (#5360), the reads written into the resolved steps.
 */
export async function withDeclaredReads(
  components: readonly DriverComponent[],
  registry: CapabilityRegistry,
  root: string,
  environment?: { env: string } & StepEnvironmentOptions,
): Promise<DriverComponent[]> {
  if (environment) components = components.map((c) => componentForEnvironment(c, environment.env, environment).component);
  const reads = await declaredReadsOf(components, registry, root);
  return reads.length > 0 ? applyDeclaredReads(components, reads) : [...components];
}

/**
 * The first chant whose `chant graph --components` draws the reads a
 * capability reports through `graphReads`: an edge from the reader to the
 * component it reads, naming the output, and a node marked external for a
 * stack no component deploys (#5331). It is also the first chant whose
 * `chant workspace graph` asks a lexicon's `workspaceStackReads` and draws the
 * reads between members.
 */
export const GRAPH_READS_FLOOR = NEXT_RELEASE;

/** A graph read with the kind of the step it names. */
export type PlacedGraphRead = GraphRead & { index: number; kind: string };

/**
 * Each capability's graph reads among `components` (#5331): the reads
 * {@link declaredReadsOf} would place, and those naming a stack outside the
 * project. A capability without `graphReads` reports its `declaredReads`
 * as they are. The steps are read for `environment` as `declaredReadsOf`
 * reads them. A capability that throws reports none.
 */
export async function graphReadsOf(
  components: readonly DriverComponent[],
  registry: CapabilityRegistry,
  root: string,
  environment?: { env: string } & StepEnvironmentOptions,
): Promise<PlacedGraphRead[]> {
  if (environment) components = components.map((c) => componentForEnvironment(c, environment.env, environment).component);
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
  const out: PlacedGraphRead[] = [];
  for (const [kind, members] of byKind) {
    const capability = registry.resolve(kind);
    let reported: GraphRead[];
    try {
      if (typeof capability.graphReads === "function") reported = await capability.graphReads({ root }, members);
      else if (typeof capability.declaredReads === "function") {
        reported = (await capability.declaredReads({ root }, members)).map((r) => ({ reader: r.reader, index: r.index ?? 0, upstream: r.upstream, output: r.output }));
      } else continue;
    } catch {
      continue;
    }
    for (const r of reported ?? []) {
      if (!names.has(r.reader) || r.reader === r.upstream) continue;
      if (r.upstream !== undefined ? !names.has(r.upstream) : r.external === undefined) continue;
      out.push({ ...r, index: r.index ?? 0, kind });
    }
  }
  return out.sort(
    (a, b) =>
      a.reader.localeCompare(b.reader) ||
      a.index - b.index ||
      (a.upstream ?? a.external ?? "").localeCompare(b.upstream ?? b.external ?? "") ||
      (a.output ?? "").localeCompare(b.output ?? ""),
  );
}
