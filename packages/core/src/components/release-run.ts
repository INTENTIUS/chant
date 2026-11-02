/**
 * A run of a release's own artifacts (#4694): `chant run --components <c>
 * --env <e> --release <label>` deploys what the cut recorded, without
 * building it again.
 *
 * The run is at the release's commit (`resolveRunRelease`, ../cli/handlers/run.ts),
 * so each component's composition is the one the cut compiled. Before
 * anything runs, each component the release recorded an artifact for has its
 * build steps (`BUILD_STEP_KINDS`) taken out, as a promote takes them out
 * (`withoutBuildSteps`, ./promote.ts), and a step that reads the output of
 * one is refused:
 *
 * - an image handed to the cut (`chant release cut --image`, the artifact's
 *   `ref`) is already in its registry. Each `release-image` step of the
 *   component is given it, and each publish step is replaced by a
 *   `release-image` step that hands on the same image, since there is no
 *   archive to publish from;
 * - an archive the cut built is published from where the cut wrote it, so the
 *   publish step stays and reads that file. A run where the file is not there
 *   is refused.
 *
 * A component with build steps whose artifact the release did not record, and
 * one with a `release-image` step when the release recorded no image for it,
 * are refused: the first would build again, the second has no image to run.
 * A component with neither build steps nor a `release-image` step runs as
 * declared. Every refusal is returned before anything runs.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DriverComponent, DriverGate, DriverPhase, DriverStep } from "./driver";
import type { Release, ReleaseArtifact } from "../lifecycle/release-store";
import { BUILD_STEP_KINDS, PUBLISH_STEP_KINDS } from "./promote";
import { parseWiringRef } from "../lint/rules/comp/support";
import { RELEASE_IMAGE_KIND } from "./verbs/release-image";

const isGate = (s: DriverStep | DriverGate | DriverPhase): s is DriverGate => (s as { kind?: unknown }).kind === "gate";
const isPhase = (s: DriverStep | DriverGate | DriverPhase): s is DriverPhase =>
  typeof (s as { phase?: unknown }).phase === "string" && Array.isArray((s as DriverPhase).steps);

/** Every step of a composition, nested phases included. */
function stepsOf(phases: readonly DriverPhase[]): DriverStep[] {
  const out: DriverStep[] = [];
  const walk = (phase: DriverPhase): void => {
    for (const s of phase.steps) {
      if (isPhase(s)) walk(s);
      else if (!isGate(s)) out.push(s);
    }
  };
  phases.forEach(walk);
  return out;
}

/** The same phases with every step `fn` maps, nested phases included. */
function mapSteps(phases: readonly DriverPhase[], fn: (step: DriverStep) => DriverStep): DriverPhase[] {
  const map = (phase: DriverPhase): DriverPhase => ({
    ...phase,
    steps: phase.steps.map((s) => (isPhase(s) ? map(s) : isGate(s) ? s : fn(s))),
  });
  return phases.map(map);
}

/** Every `@Phase.field` a step's fields read. */
function priorStepReads(step: DriverStep): Array<{ phase: string; field: string }> {
  const out: Array<{ phase: string; field: string }> = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const ref = parseWiringRef(v);
      if (ref?.kind === "prior-step") out.push({ phase: ref.phaseName, field: ref.field });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object" && !("stackOutput" in v)) Object.values(v as Record<string, unknown>).forEach(walk);
  };
  const { kind: _kind, ...fields } = step;
  walk(fields);
  return out;
}

/**
 * `component` without its build steps, a phase left with nothing dropped, or
 * why it can't be: a step left reads an output of a phase that held only
 * build steps.
 */
function withoutBuilds(component: DriverComponent): { component: DriverComponent; removed: string[] } | { error: string } {
  const removed: string[] = [];
  const emptied = new Set<string>();
  const strip = (phase: DriverPhase): DriverPhase | undefined => {
    const steps: DriverPhase["steps"] = [];
    let lost = false;
    for (const s of phase.steps) {
      if (isPhase(s)) {
        const nested = strip(s);
        if (nested) steps.push(nested);
      } else if (!isGate(s) && BUILD_STEP_KINDS.includes(s.kind)) {
        removed.push(s.kind);
        lost = true;
      } else steps.push(s);
    }
    if (lost && !steps.some((s) => !isGate(s))) emptied.add(phase.phase);
    return steps.length > 0 ? { ...phase, steps } : undefined;
  };
  const deploy = component.deploy.map(strip).filter((p): p is DriverPhase => p !== undefined);
  for (const step of stepsOf(deploy)) {
    const read = priorStepReads(step).find((r) => emptied.has(r.phase));
    if (read) {
      return { error: `component "${component.name}" reads "@${read.phase}.${read.field}", an output of a build step a run under a release does not run` };
    }
  }
  return { component: { ...component, deploy }, removed };
}

/** What a component's run under a release will do, for the run to print. */
export interface ReleaseRunNote {
  component: string;
  /** The build step kinds taken out. */
  removed: string[];
  /** The image the component runs, when one was handed to the cut. */
  image?: string;
}

/**
 * The compositions to run under `release`, or every reason a component can't
 * be run from it. `memberDir` is where the cut's archive paths are read from.
 */
export function releaseRunComponents(
  components: readonly DriverComponent[],
  release: Pick<Release, "releaseDigest" | "artifactDigests">,
  memberDir: string,
  label: string | null = null,
): { components: DriverComponent[]; notes: ReleaseRunNote[] } | { errors: string[] } {
  const name = label ?? release.releaseDigest;
  const errors: string[] = [];
  const out: DriverComponent[] = [];
  const notes: ReleaseRunNote[] = [];
  for (const component of components) {
    const artifacts = release.artifactDigests.filter((a) => a.component === component.name);
    const handed = artifacts.find((a): a is ReleaseArtifact & { ref: string } => typeof a.ref === "string");
    const steps = stepsOf(component.deploy);
    const builds = steps.some((s) => BUILD_STEP_KINDS.includes(s.kind));
    const wantsImage = steps.some((s) => s.kind === RELEASE_IMAGE_KIND);

    if (wantsImage && !handed) {
      errors.push(
        `component "${component.name}" runs the image release ${name} recorded for it (a release-image step), and the release recorded none; ` +
          `hand the cut its image: chant release cut <label> --image ${component.name}=<repository>@sha256:<hex>`,
      );
      continue;
    }
    if (!builds && !handed) {
      out.push(component);
      continue;
    }
    if (artifacts.length === 0) {
      errors.push(
        `component "${component.name}" builds an artifact, and release ${name} recorded none for it, so the run would build it again; ` +
          `cut a release that builds it, or hand the cut its image with --image`,
      );
      continue;
    }
    if (!handed) {
      const missing = artifacts.filter((a) => a.path === "" || !existsSync(isAbsolute(a.path) ? a.path : resolve(memberDir, a.path)));
      if (missing.length > 0) {
        errors.push(
          `component "${component.name}": release ${name} built ${missing.map((a) => a.path || a.kind).join(", ")}, which is not here, so the run can't publish the release's own artifact; ` +
            `run where the cut built it, or push the image and hand the cut its digest with --image`,
        );
        continue;
      }
    }
    // An image handed to the cut is in its registry already: a publish step hands it on rather than pushing an archive.
    const filled = handed
      ? mapSteps(component.deploy, (s) =>
          s.kind === RELEASE_IMAGE_KIND
            ? { ...s, uri: handed.ref, digest: handed.digest }
            : PUBLISH_STEP_KINDS.includes(s.kind)
              ? { kind: RELEASE_IMAGE_KIND, uri: handed.ref, digest: handed.digest, replaces: s.kind }
              : s,
        )
      : component.deploy;
    const stripped = withoutBuilds({ ...component, deploy: filled });
    if ("error" in stripped) {
      errors.push(stripped.error);
      continue;
    }
    out.push(stripped.component);
    notes.push({ component: component.name, removed: stripped.removed, ...(handed ? { image: handed.ref } : {}) });
  }
  return errors.length > 0 ? { errors } : { components: out, notes };
}
