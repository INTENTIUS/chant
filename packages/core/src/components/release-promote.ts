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
 *
 * A release cut since #4155 (a target with `trees`) records every local path
 * a deploy step names (`recordedInputRefs`), directories file by file. A
 * promote points each of them at the recorded copy: a directory is written
 * under `.chant/release-templates/<digest>/<name>/`, its digest taken over its
 * files the way a gate's directory digest is (`./deploy-inputs.ts`). A path
 * outside the template fields that the release does not record, such as a
 * chart named from a repository, is left as written. A target cut before
 * #4155 is pinned as it was then: template fields only, other paths read from
 * the checkout.
 */

import { mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DriverComponent, DriverGate, DriverPhase, DriverStep } from "./driver";
import { recordedFields, recordedInputRefs, TEMPLATE_FIELDS, templateRefs, type RecordedInputRef } from "./release-compile";
import { templateBytesDigest, type Release, type ReleaseTarget } from "../lifecycle/release-store";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { BuildArchiveManifest } from "./verbs/build-archive";

/** Where a promote under a release writes the recorded templates, relative to the member's directory. */
export const RELEASE_TEMPLATES_DIR = ".chant/release-templates";

/** A template ready to write: where, and its bytes. */
export interface PinnedTemplate {
  /** Relative to the member's directory. */
  path: string;
  /** The text, or the base64 of the bytes under `encoding: "base64"`. */
  content: string;
  encoding?: "base64";
}

/** Reads a recorded template's stored copy by digest: its text, or its base64 under `base64`. */
export type TemplateReader = (digest: string, encoding?: "base64") => Promise<string | null>;

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
  readTemplate: TemplateReader,
): Promise<{ components: DriverComponent[]; files: PinnedTemplate[] } | { errors: string[] }> {
  const errors: string[] = [];
  const files: PinnedTemplate[] = [];
  const out: DriverComponent[] = [];
  // #4155: a target with `trees` records every deploy input; one without was cut before and records template fields only.
  const full = target.trees !== undefined;
  for (const component of components) {
    const replace = new Map<string, string>();
    const refs: RecordedInputRef[] = full ? recordedInputRefs(component) : templateRefs(component).map((r) => ({ ...r, required: true }));
    for (const ref of refs) {
      if (replace.has(ref.value)) continue;
      const dir = ref.path.replace(/\/+$/, "");
      const tree = full ? target.trees!.find((t) => t.component === component.name && t.path === dir) : undefined;
      if (tree) {
        const pinned = await pinTree(component.name, tree.path, target, readTemplate);
        if ("errors" in pinned) errors.push(...pinned.errors);
        else {
          files.push(...pinned.files);
          replace.set(ref.value, pinned.path);
        }
        continue;
      }
      const recorded = target.templates.find((t) => t.component === component.name && t.path === ref.path);
      if (!recorded) {
        if (!ref.required) continue;
        errors.push(
          `component "${component.name}" reads ${ref.field} "${ref.value}", which release ${release.releaseDigest} does not record for "${target.env}"; ` +
            `this checkout's deploy is not the one the release was compiled from (commit ${release.commit.slice(0, 12)})`,
        );
        continue;
      }
      const read = await readChecked(component.name, ref.path, recorded, target, readTemplate);
      if ("error" in read) {
        errors.push(read.error);
        continue;
      }
      const path = join(RELEASE_TEMPLATES_DIR, recorded.digest.replace(/:/g, "_"), basename(ref.path));
      files.push({ path, content: read.content, ...(recorded.encoding ? { encoding: recorded.encoding } : {}) });
      replace.set(ref.value, path);
    }
    const rewrite = (phase: DriverPhase): DriverPhase => ({
      ...phase,
      steps: phase.steps.map((step) => {
        if (isPhase(step)) return rewrite(step);
        if (isGate(step)) return step;
        const next: DriverStep = { ...step };
        for (const field of full ? recordedFields(step.kind) : TEMPLATE_FIELDS) {
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

/** One recorded template's stored copy, checked against its digest. */
async function readChecked(
  component: string | null,
  path: string,
  recorded: ReleaseTarget["templates"][number],
  target: ReleaseTarget,
  readTemplate: TemplateReader,
): Promise<{ content: string } | { error: string }> {
  const who = component === null ? "" : `component "${component}": `;
  const content = await readTemplate(recorded.digest, recorded.encoding);
  if (content === null) return { error: `${who}the bytes of template "${path}" (${recorded.digest}) are not on the chant/lifecycle branch; fetch it and try again` };
  const got = templateBytesDigest(content, recorded.encoding);
  if (got !== recorded.digest) {
    return { error: `${who}template "${path}" hashes to ${got}, but the release's target for "${target.env}" records ${recorded.digest}; refusing to deploy it` };
  }
  return { content };
}

/**
 * A recorded directory's files, under `.chant/release-templates/<digest>/<name>/`
 * (#4155). The digest is taken over the files' paths from the directory and
 * their bytes, as a gate's directory digest is, so the path names the tree.
 */
async function pinTree(
  component: string,
  dir: string,
  target: ReleaseTarget,
  readTemplate: TemplateReader,
): Promise<{ path: string; files: PinnedTemplate[] } | { errors: string[] }> {
  const prefix = `${dir}/`;
  const entries = target.templates.filter((t) => t.component === component && t.path.startsWith(prefix));
  const errors: string[] = [];
  const read: Array<{ rel: string; content: string; encoding?: "base64"; digest: string }> = [];
  for (const e of entries) {
    const got = await readChecked(component, e.path, e, target, readTemplate);
    if ("error" in got) errors.push(got.error);
    else read.push({ rel: e.path.slice(prefix.length), content: got.content, digest: e.digest, ...(e.encoding ? { encoding: e.encoding } : {}) });
  }
  if (errors.length > 0) return { errors };
  read.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const digest = computePlanDigest("directory", read.map(({ rel, digest }) => ({ path: rel, digest })));
  const path = join(RELEASE_TEMPLATES_DIR, digest.replace(/:/g, "_"), basename(dir));
  return { path, files: read.map((r) => ({ path: join(path, r.rel), content: r.content, ...(r.encoding ? { encoding: r.encoding } : {}) })) };
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
  readTemplate: TemplateReader,
): Promise<{ files: PinnedTemplate[] } | { errors: string[] }> {
  const errors: string[] = [];
  const files: PinnedTemplate[] = [];
  for (const t of target.templates) {
    const who = t.component === null ? "" : `component "${t.component}": `;
    if (t.path.startsWith("/") || t.path.split("/").includes("..")) {
      errors.push(`${who}template "${t.path}" is not a path inside the member's directory; refusing to write it`);
      continue;
    }
    const content = await readTemplate(t.digest, t.encoding);
    if (content === null) {
      errors.push(`${who}the bytes of template "${t.path}" (${t.digest}) are not on the chant/lifecycle branch; fetch it and try again`);
      continue;
    }
    const got = templateBytesDigest(content, t.encoding);
    if (got !== t.digest) {
      errors.push(`${who}template "${t.path}" hashes to ${got}, but release ${release.releaseDigest} records ${t.digest} for "${target.env}"; refusing to write it`);
      continue;
    }
    const same = files.find((f) => f.path === t.path);
    if (same) {
      if (same.content !== content) errors.push(`two components record different bytes at "${t.path}" for "${target.env}", so they can't both be written there`);
      continue;
    }
    files.push({ path: t.path, content, ...(t.encoding ? { encoding: t.encoding } : {}) });
  }
  return errors.length > 0 ? { errors } : { files };
}

/** Write the pinned templates under `dir`, the member's directory. */
export function writePinnedTemplates(dir: string, files: readonly PinnedTemplate[]): void {
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
  }
}

/**
 * Remove the templates {@link writePinnedTemplates} wrote once the promote is
 * done, and {@link RELEASE_TEMPLATES_DIR} with them when nothing else is in
 * it, so a promote leaves the checkout as it found it. A re-run writes them
 * again from the release.
 */
export function removePinnedTemplates(dir: string, files: readonly PinnedTemplate[]): void {
  // Each file sits under `.chant/release-templates/<digest>/`, a recorded tree's deeper; that digest directory goes.
  const prefix = RELEASE_TEMPLATES_DIR.split("/").length;
  for (const f of files) rmSync(join(dir, ...f.path.split(/[\\/]/).slice(0, prefix + 1)), { recursive: true, force: true });
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
