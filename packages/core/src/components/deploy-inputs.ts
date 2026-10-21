/**
 * The local files a component's steps deploy from, and their content digests
 * (#4155).
 *
 * A component gate approves `componentPlanDigest` (./gate-plan.ts). A step
 * whose capability has a `plan` is bound by what it plans. Every other step
 * was bound only by its input as written, so a Helm chart, a kustomize
 * directory or a static site's tree could change after review without moving
 * the digest. This module names those files and hashes them, so the digest
 * moves when they do.
 *
 * Which fields name a path is data, as the template fields are in
 * ./release-compile.ts and the unit fields in ./deploy-units.ts: a kind's
 * fields in {@link DEPLOY_INPUT_FIELDS}, plus `template`, `manifest` and
 * `values` on any step ({@link TEMPLATE_FIELDS}). Only a literal path counts:
 * a value wired from another step (`@Build.uri`) or an `archive:` path is a
 * build output, and binding it would make an approval unusable by a build
 * that is not reproducible. The build steps' own sources are bound instead.
 *
 * - A file is hashed by its bytes.
 * - A directory is hashed over the files under it that git does not ignore
 *   (`git ls-files --cached --others --exclude-standard`), each by its path
 *   and bytes, so `node_modules` and a build's `dist` inside a Docker context
 *   are left out. Outside a git repository every file is hashed except under
 *   `.git` and `node_modules`.
 * - A directory git ignores as a whole is a build output. It is not hashed;
 *   the step is listed as unbound, with that reason.
 * - A path that does not exist is left out. One that appears later moves the
 *   digest.
 *
 * A step whose kind runs content chant can't name, such as `shell`, is listed
 * as unbound ({@link UNBOUND_KINDS}), so the plan note can show a reviewer
 * what the approval does not cover.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "../content-digest";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { DriverGate, DriverPhase, DriverStep } from "./driver";

/** The fields that name every step's deployed file, whatever its kind (as ./release-compile.ts reads them). */
export const TEMPLATE_FIELDS: readonly string[] = ["template", "manifest", "values"];

/** Per kind, the fields beyond {@link TEMPLATE_FIELDS} that name a local file or directory the step deploys or builds from. */
export const DEPLOY_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "helm-upgrade": ["chart"],
  "kustomize-apply": ["dir"],
  "fly-release": ["plan"],
  "fly-rollback": ["plan"],
  "s3-sync": ["from"],
  "r2-sync": ["from"],
  "copy-to-host": ["from"],
  "wrangler-deploy": ["config"],
  "wrangler-versions-promote": ["config"],
  "docker-build": ["context"],
  "zip-package": ["source"],
  "jvm-build": ["path"],
};

/** Kinds that deploy content chant can't name from their input: a command, an agent's work. */
export const UNBOUND_KINDS: readonly string[] = ["shell", "run-agent"];

/** One path a step names. */
export interface DeployInputRef {
  phase: string;
  kind: string;
  field: string;
  /** Relative to the member's directory, as written. */
  path: string;
}

/** A named path and the digest of what is there. */
export interface DeployInputDigest {
  path: string;
  /** `sha256:<hex>` of a file's bytes, or a plan digest over a directory's files. */
  digest: string;
}

/** A step the digest does not cover, and why. */
export interface UnboundStep {
  phase: string;
  kind: string;
  reason: string;
}

/** What a component's steps deploy from: the digests, and the steps they can't cover. */
export interface ComponentDeployInputs {
  inputs: DeployInputDigest[];
  unbound: UnboundStep[];
}

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

const isLiteralPath = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.startsWith("@") && !v.startsWith("$") && !v.startsWith("archive:");

/** Every capability step of a composition with its phase, nested phases included, gates left out. */
export function stepsWithPhase(phases: readonly DriverPhase[]): Array<{ phase: string; step: DriverStep }> {
  const out: Array<{ phase: string; step: DriverStep }> = [];
  const walk = (phase: DriverPhase): void => {
    for (const step of phase.steps) {
      if (isPhase(step)) walk(step);
      else if (!isGate(step)) out.push({ phase: phase.phase, step });
    }
  };
  phases.forEach(walk);
  return out;
}

/** The literal paths one step names, in field order. A Docker build's Dockerfile is named under its context. */
export function stepInputRefs(phase: string, step: DriverStep): DeployInputRef[] {
  const out: DeployInputRef[] = [];
  for (const field of [...TEMPLATE_FIELDS, ...(DEPLOY_INPUT_FIELDS[step.kind] ?? [])]) {
    const raw = step[field];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (isLiteralPath(value)) out.push({ phase, kind: step.kind, field, path: value });
    }
  }
  if (step.kind === "docker-build" && isLiteralPath(step.context) && isLiteralPath(step.dockerfile)) {
    out.push({ phase, kind: step.kind, field: "dockerfile", path: join(step.context, step.dockerfile) });
  }
  return out;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** The files under `dir` (relative to `root`) a directory digest covers, relative to `root`, sorted. */
export function directoryFiles(root: string, dir: string): string[] {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir]);
  if (listed.ok) {
    return [...new Set(listed.out.split("\0").filter((p) => p !== ""))]
      .filter((p) => {
        const full = resolve(root, p);
        return existsSync(full) && statSync(full).isFile();
      })
      .sort();
  }
  return walkFiles(root, dir);
}

/** Every file under `dir`, relative to `root`, sorted, leaving out `.git` and `node_modules`. What a cut records of a directory git ignores. */
export function walkFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(resolve(root, dir));
  return out.sort();
}

/** Whether git ignores `path` (relative to `root`). False outside a git repository. */
export function ignoredByGit(root: string, path: string): boolean {
  return git(root, ["check-ignore", "-q", "--", path]).ok;
}

/** `sha256:<hex>` of a file's bytes. */
export function fileDigest(file: string): string {
  return `sha256:${sha256Hex(readFileSync(file))}`;
}

/** The digest of the files under `dir`: a plan digest over each file's path (from `dir`) and bytes. */
export function directoryDigest(root: string, dir: string): string {
  const base = resolve(root, dir);
  const files = directoryFiles(root, dir).map((p) => ({
    path: relative(base, resolve(root, p)).split(sep).join("/"),
    digest: fileDigest(resolve(root, p)),
  }));
  return computePlanDigest("directory", files);
}

/**
 * What a component's steps deploy from, read under `root` (the member's
 * directory). `include` picks the steps to read, all of them by default; the
 * wave planner passes the steps without a `plan`, which their plan does not
 * already cover.
 */
export function componentDeployInputs(
  phases: readonly DriverPhase[],
  root: string,
  include: (step: DriverStep) => boolean = () => true,
): ComponentDeployInputs {
  const inputs = new Map<string, string>();
  const unbound: UnboundStep[] = [];
  for (const { phase, step } of stepsWithPhase(phases)) {
    if (!include(step)) continue;
    if (UNBOUND_KINDS.includes(step.kind)) {
      unbound.push({ phase, kind: step.kind, reason: `a ${step.kind} step runs content chant can't name from its input` });
      continue;
    }
    for (const ref of stepInputRefs(phase, step)) {
      if (inputs.has(ref.path)) continue;
      const full = resolve(root, ref.path);
      if (!existsSync(full)) continue;
      if (statSync(full).isDirectory()) {
        if (ignoredByGit(root, ref.path)) {
          unbound.push({ phase, kind: step.kind, reason: `its ${ref.field} "${ref.path}" is a directory git ignores, so a build output; bind its sources through the step that builds it` });
          continue;
        }
        inputs.set(ref.path, directoryDigest(root, ref.path));
      } else {
        inputs.set(ref.path, fileDigest(full));
      }
    }
  }
  return {
    inputs: [...inputs].map(([path, digest]) => ({ path, digest })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    unbound,
  };
}
