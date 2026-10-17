/**
 * A promote under a release (#4026, ws-104 question 5): the deploy reads the
 * templates the release recorded for the target environment, not the ones in
 * the promoting checkout.
 *
 * Each template a promoted component's deploy names ({@link templateRefs}) has
 * to be one the release's target records for that component. Its bytes are
 * read from `_releases/templates/` on `chant/lifecycle` and checked against
 * the target's digest, the way a promote checks the publish digest, and a
 * mismatch refuses the promote before anything runs. The bytes are written
 * under `.chant/release-templates/<digest>/` in the member's directory and the
 * step reads them from there. The path is relative and fixed by the digest,
 * so a gate approval bound to the promote's plan still matches on a re-run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { contentDigest } from "../content-digest";
import type { DriverComponent, DriverGate, DriverPhase, DriverStep } from "./driver";
import { TEMPLATE_FIELDS, templateRefs } from "./release-compile";
import type { Release, ReleaseTarget } from "../lifecycle/release-store";

/** Where a promote under a release writes the recorded templates, relative to the member's directory. */
export const RELEASE_TEMPLATES_DIR = ".chant/release-templates";

/** A template ready to write: where, and its bytes. */
export interface PinnedTemplate {
  /** Relative to the member's directory. */
  path: string;
  content: string;
}

/** The release's target for `env`, or an error naming the environments it has. */
export function targetFor(release: Release, env: string): { target: ReleaseTarget } | { error: string } {
  const target = release.targets.find((t) => t.env === env);
  if (target) return { target };
  return {
    error: `release ${release.releaseDigest} has no target for "${env}"; it was compiled for ${release.targets.map((t) => t.env).join(", ") || "no environment"}`,
  };
}

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/**
 * Point every template `components` read at the target's recorded bytes.
 * Returns the rewritten compositions and the files to write, or the reasons
 * the promote is refused: a template the target does not record, one whose
 * bytes are missing, or one whose bytes do not hash to the target's digest.
 */
export async function pinReleaseTemplates(
  components: readonly DriverComponent[],
  release: Release,
  target: ReleaseTarget,
  readTemplate: (digest: string) => Promise<string | null>,
): Promise<{ components: DriverComponent[]; files: PinnedTemplate[] } | { errors: string[] }> {
  const errors: string[] = [];
  const files: PinnedTemplate[] = [];
  const out: DriverComponent[] = [];
  for (const component of components) {
    const replace = new Map<string, string>();
    for (const ref of templateRefs(component)) {
      if (replace.has(ref.value)) continue;
      const recorded = target.templates.find((t) => t.component === component.name && t.path === ref.path);
      if (!recorded) {
        errors.push(
          `component "${component.name}" reads ${ref.field} "${ref.value}", which release ${release.releaseDigest} does not record for "${target.env}"; ` +
            `this checkout's deploy is not the one the release was compiled from (commit ${release.commit.slice(0, 12)})`,
        );
        continue;
      }
      const content = await readTemplate(recorded.digest);
      if (content === null) {
        errors.push(`component "${component.name}": the bytes of template "${ref.path}" (${recorded.digest}) are not on the chant/lifecycle branch; fetch it and try again`);
        continue;
      }
      const got = contentDigest(content);
      if (got !== recorded.digest) {
        errors.push(
          `component "${component.name}": template "${ref.path}" hashes to ${got}, but the release's target for "${target.env}" records ${recorded.digest}; refusing to deploy it`,
        );
        continue;
      }
      const path = join(RELEASE_TEMPLATES_DIR, recorded.digest.replace(/:/g, "_"), basename(ref.path));
      files.push({ path, content });
      replace.set(ref.value, path);
    }
    const rewrite = (phase: DriverPhase): DriverPhase => ({
      ...phase,
      steps: phase.steps.map((step) => {
        if (isPhase(step)) return rewrite(step);
        if (isGate(step)) return step;
        const next: DriverStep = { ...step };
        for (const field of TEMPLATE_FIELDS) {
          const v = next[field];
          if (typeof v === "string" && replace.has(v)) next[field] = replace.get(v);
          else if (Array.isArray(v)) next[field] = v.map((x) => (typeof x === "string" && replace.has(x) ? replace.get(x) : x));
        }
        return next;
      }),
    });
    out.push({ ...component, deploy: component.deploy.map(rewrite) });
  }
  return errors.length > 0 ? { errors } : { components: out, files };
}

/** Write the pinned templates under `dir`, the member's directory. */
export function writePinnedTemplates(dir: string, files: readonly PinnedTemplate[]): void {
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
}
