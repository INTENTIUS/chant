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

import { mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { contentDigest } from "../content-digest";
import type { DriverComponent, DriverGate, DriverPhase, DriverStep } from "./driver";
import { TEMPLATE_FIELDS, templateRefs } from "./release-compile";
import type { Release, ReleaseTarget } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { BuildArchiveManifest } from "./verbs/build-archive";

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

/** Whether a release is of a project with no components (#4046): no artifact, and every template it records has `component: null`. */
export function isImplicitRelease(release: Release): boolean {
  const templates = release.targets.flatMap((t) => t.templates);
  return release.artifactDigests.length === 0 && templates.length > 0 && templates.every((t) => t.component === null);
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

/**
 * The files a release's target records, read back by digest and checked, for
 * `chant release export` (#4046). A project with no components has no deploy
 * step for a promote to point at the recorded bytes, so its deploy (an Op such
 * as `chant run deploy`, or a CI job) reads the files this writes instead of
 * building them again. Each path is the one the build wrote, relative to the
 * member's directory; a template whose bytes are missing or don't hash to the
 * target's digest is refused, as {@link pinReleaseTemplates} refuses one.
 */
export async function targetFiles(
  release: Release,
  target: ReleaseTarget,
  readTemplate: (digest: string) => Promise<string | null>,
): Promise<{ files: PinnedTemplate[] } | { errors: string[] }> {
  const errors: string[] = [];
  const files: PinnedTemplate[] = [];
  for (const t of target.templates) {
    const who = t.component === null ? "" : `component "${t.component}": `;
    if (t.path.startsWith("/") || t.path.split("/").includes("..")) {
      errors.push(`${who}template "${t.path}" is not a path inside the member's directory; refusing to write it`);
      continue;
    }
    const content = await readTemplate(t.digest);
    if (content === null) {
      errors.push(`${who}the bytes of template "${t.path}" (${t.digest}) are not on the chant/lifecycle branch; fetch it and try again`);
      continue;
    }
    const got = contentDigest(content);
    if (got !== t.digest) {
      errors.push(`${who}template "${t.path}" hashes to ${got}, but release ${release.releaseDigest} records ${t.digest} for "${target.env}"; refusing to write it`);
      continue;
    }
    const same = files.find((f) => f.path === t.path);
    if (same) {
      if (same.content !== content) errors.push(`two components record different bytes at "${t.path}" for "${target.env}", so they can't both be written there`);
      continue;
    }
    files.push({ path: t.path, content });
  }
  return errors.length > 0 ? { errors } : { files };
}

/** Write the pinned templates under `dir`, the member's directory. */
export function writePinnedTemplates(dir: string, files: readonly PinnedTemplate[]): void {
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
}

/**
 * Remove the templates {@link writePinnedTemplates} wrote once the promote is
 * done, and {@link RELEASE_TEMPLATES_DIR} with them when nothing else is in
 * it, so a promote leaves the checkout as it found it. A re-run writes them
 * again from the release.
 */
export function removePinnedTemplates(dir: string, files: readonly PinnedTemplate[]): void {
  for (const f of files) rmSync(dirname(join(dir, f.path)), { recursive: true, force: true });
  const root = join(dir, RELEASE_TEMPLATES_DIR);
  try {
    if (readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // Already gone, or not ours to remove.
  }
}

/**
 * Whether the artifact a promote deploys under a release is one the release
 * built (#4045, the rule #4026 left open). The release records build digests
 * (`artifactDigests`, the digest the archive step returned), and a deploy
 * record carries the publish digest, which is another value for an image, so
 * the two are compared through the build manifest the source deploy record
 * names (`manifestDigest`), whose entries carry build digests at the same
 * archive paths:
 *
 * - a source record that names this release in `releaseDigest` matches;
 * - else, each of the release's artifacts for the component must be in that
 *   manifest at its path with the release's digest, and one that differs is
 *   a mismatch;
 * - a record with no `manifestDigest`, a manifest that isn't stored, or an
 *   artifact path the manifest doesn't hold can't be compared.
 *
 * A mismatch is a warning, not a refusal. The environment promoted from was
 * deployed by its own `run --components`, which builds again, and an image
 * build is not reproducible, so its digest differs from the cut's for the
 * same commit. Refusing would refuse every image promote until a deploy can
 * run the release's own artifacts (#4043).
 */
export async function releaseArtifactMismatches(
  release: Release,
  sources: ReadonlyArray<{ component: string; source: ReleaseRecord }>,
  readManifest: (manifestDigest: string) => Promise<BuildArchiveManifest | null>,
): Promise<string[]> {
  const out: string[] = [];
  for (const { component, source } of sources) {
    if (source.releaseDigest === release.releaseDigest) continue;
    const artifacts = release.artifactDigests.filter((a) => a.component === component);
    if (artifacts.length === 0 || source.manifestDigest === undefined) continue;
    const manifest = await readManifest(source.manifestDigest);
    if (!manifest) continue;
    for (const a of artifacts) {
      const entry = manifest.contents.find((e) => e.path === a.path && e.kind === a.kind);
      if (entry && entry.digest !== a.digest) {
        out.push(
          `${component}: the ${source.env} deploy being promoted was built with ${a.path} at ${entry.digest}, ` +
            `but release ${release.releaseDigest} built it at ${a.digest}, so the artifact deployed is not the release's own`,
        );
      }
    }
  }
  return out;
}
