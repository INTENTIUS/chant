/**
 * Reading a helm-chart workspace member into the graph (#3179).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `helm-chart`, with `helm.member` in its config (see `workspace-kinds.json`).
 * The plugin's `buildRoots` hook calls {@link readHelmMember}: `helm template`
 * over the chart directory, and the rendered objects are the member's nodes.
 *
 * With no `helm` binary the member contributes no objects, and its report says
 * `rendered: false` with the reason. A render the binary ran and refused (a
 * template that doesn't parse, a dependency that isn't built) is not that case
 * and throws, so a broken chart is never a quiet empty graph.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { addRenderedEntity, renderedManifestEntity } from "@intentius/chant-lexicon-k8s/kustomize/rendered-entity";

const execFileAsync = promisify(execFile);

export interface HelmMemberConfig {
  /** The chart directory, absolute. */
  dir: string;
  /** Names the entities (`<label>/deploymentWeb`): the member's name. */
  label?: string;
}

/** What the read found, carried on the graph's `meta.helmMember`. */
export interface HelmMemberReport {
  rendered: boolean;
  /** Why nothing was read; set with `rendered: false`. */
  reason?: string;
  objects: number;
}

/** Runs the helm binary with these arguments. Injectable so tests need no binary. */
export type HelmRunner = (args: string[]) => Promise<{ stdout: string }>;

export const defaultHelmRunner: HelmRunner = (args) => execFileAsync("helm", args, { maxBuffer: 64 * 1024 * 1024 });

/** The exact render argv: the release is named for the chart directory. */
export function helmTemplateArgs(dir: string): string[] {
  return ["template", basename(dir) || "release", dir];
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /ENOENT|command not found/.test(err instanceof Error ? err.message : String(err));
}

export async function readHelmMember(opts: {
  member: HelmMemberConfig;
  run?: HelmRunner;
}): Promise<{ entities: Map<string, Declarable>; warnings: string[]; report: HelmMemberReport }> {
  const { member } = opts;
  const label = member.label ?? basename(member.dir);
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  let stdout: string;
  try {
    ({ stdout } = await (opts.run ?? defaultHelmRunner)(helmTemplateArgs(member.dir)));
  } catch (err) {
    if (!isMissingBinary(err)) throw err;
    const reason = `Cannot render chart "${member.dir}": the \`helm\` binary was not found on PATH. Install helm and retry.`;
    warnings.push(`helm-chart member "${label}" was not rendered: ${reason}`);
    return { entities, warnings, report: { rendered: false, reason, objects: 0 } };
  }

  for (const doc of loadAll(stdout)) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    const entity = renderedManifestEntity(doc as Record<string, unknown>, label);
    if (!entity) {
      warnings.push(`helm-chart member "${label}" rendered a document without apiVersion/kind; skipped`);
      continue;
    }
    addRenderedEntity(entities, label, entity);
  }
  return { entities, warnings, report: { rendered: true, objects: entities.size } };
}

let lastReport: HelmMemberReport | undefined;

/**
 * The report of the read in this process. `graphMeta` receives only the
 * entities, so the hook that read the member leaves its report here for the
 * hook that publishes it; `chant graph` runs the two in order in one process.
 */
export function setLastMemberReport(report: HelmMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): HelmMemberReport | undefined {
  return lastReport;
}
