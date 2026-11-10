/**
 * The apply statuses of an Op waves run (#4987): `<product>/apply` on the
 * commit the waves applied, after each wave and after the last.
 *
 * A job of its own posts each one, `apply-status-<n>`, after wave n's jobs,
 * at the default branch's commit with the wave jobs' outcome files. It runs
 * none of the change's code: a before-merge run's wave jobs run the pull
 * request's head, and this job holds the status token they do not need.
 * The commit is the push's, or a before-merge run's decided head.
 *
 * What it posts, from the outcomes of waves 1 to n (`applyOutcomeOf`):
 *
 * - every run applied or had nothing to apply: `wave n of N applied`,
 *   pending, until the last wave, whose status is the one success;
 * - a run waits at its gate: pending, `wave n of N waits for an approval`
 *   (failed on GitLab, which refuses to move a running status back to
 *   pending and keeps the pipeline running while one is left running; a
 *   retry posts a new one);
 * - a run failed, or was blocked by one that did: failed, with the counts.
 *
 * A wave that wrote no outcome (its job stopped before its command, or the
 * waves stopped before it) gets no status: the one before it stands, and
 * the run's own jobs say what stopped.
 *
 * Kept free of the forge client and git, so the generators import the
 * names and the command line alone.
 */

import { applyOutcomeOf } from "../control/applied";
import { earlierWaveOutcomes, passesThrough, type WaveMemberOutcome } from "../wave-blocked";
import type { ForgeStatusState, PrForge } from "../pr-forge";

/** The apply statuses option of an Op waves pipeline (#4987), `OpWavesPipelineOptions.applyStatus`. */
export interface OpWavesApplyStatus {
  /** The status's name, such as `terragucci/apply`: `productStatusContext(words, "apply", member)`. */
  context: string;
}

/** The job after wave `wave` that posts its apply status. */
export function applyStatusJobName(wave: number): string {
  return `apply-status-${wave}`;
}

/** Whether `context` is a status name a forge keeps: no spaces, quotes or shell characters, at most 255 characters. */
export function assertApplyStatusContext(context: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,254}$/.test(context)) throw new Error(`applyStatus.context ${JSON.stringify(context)} is not a status name: letters, digits, '.', '_', '/', ':' and '-'`);
}

/**
 * The status job's command, through the product's bin: `chant run wave --op
 * <op> --wave <n> --of <count> --apply-status <context> --at <sha> --forge
 * <forge>`. It names the op and the wave count rather than the spec file,
 * which a spec rendered at run time (#4982) leaves uncommitted.
 */
export function applyStatusCommand(spec: { name: string; waves: readonly unknown[] }, wave: number, context: string, forge: "github" | "forgejo" | "gitlab", at: string, bin?: string): string {
  const words = (bin ?? "").split(/\s+/).filter(Boolean);
  return [
    ...(words.length > 0 ? words : ["chant"]),
    "run", "wave", "--op", spec.name, "--wave", String(wave), "--of", String(spec.waves.length),
    "--apply-status", context, "--at", at, "--forge", forge,
  ].join(" ");
}

/** The status one wave's job posts, or none. */
export interface OpWaveApplyStatus {
  state: Extract<ForgeStatusState, "running" | "success" | "failed">;
  description: string;
}

/**
 * The apply status after wave `wave` of `of`, from the outcome files under
 * `dirs`. Undefined when wave `wave` wrote no outcome.
 */
export function opWaveApplyStatus(dirs: readonly string[], wave: number, of: number, forge: "github" | "forgejo" | "gitlab"): OpWaveApplyStatus | undefined {
  const { members } = earlierWaveOutcomes(dirs, wave + 1);
  if (![...members.values()].some((m) => m.wave === wave)) return undefined;
  const summary = applyOutcomeOf(members);
  const where = `wave ${wave} of ${of}`;
  if (summary.outcome === "applied" || summary.outcome === "unchanged") {
    if (wave < of) return { state: "running", description: `${where} applied` };
    return { state: "success", description: of === 1 ? "the wave applied" : `all ${of} waves applied` };
  }
  // A run that waits, or one held by it, is not a failure; any other run that did not get through is.
  const waits = (o: WaveMemberOutcome): boolean => o.status === "waiting" || (o.status === "blocked" && o.by !== undefined && members.get(o.by)?.status === "waiting");
  const held = [...members.values()].filter((o) => !passesThrough(o));
  if (held.length > 0 && held.every(waits)) return { state: forge === "gitlab" ? "failed" : "running", description: `${where} waits for an approval` };
  const counts = Object.entries(summary.counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${n} ${k}`).join(", ");
  return { state: "failed", description: `${where}: ${counts}` };
}

/** What {@link postOpWaveApplyStatus} posts with. */
export interface PostApplyStatusInput {
  forge: Pick<PrForge, "kind" | "setStatus" | "runUrl">;
  /** The directories the wave jobs' outcome files were downloaded into. */
  dirs: readonly string[];
  wave: number;
  of: number;
  context: string;
  /** The commit the waves applied: the push's, or a before-merge run's decided head. */
  at: string;
  /** GitLab: the pipeline the status belongs to, when `at` is the pipeline's own commit; else GitLab files it under the commit's newest pipeline. */
  pipelineId?: number;
}

/**
 * Post the apply status after wave `wave` on `at` (#4987), linked to the
 * run. Resolves to the line the job logs; a wave with no outcome posts
 * nothing. The forge's refusal is thrown.
 */
export async function postOpWaveApplyStatus(i: PostApplyStatusInput): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/.test(i.at)) throw new Error(`--at names the commit the waves applied, a full sha, not ${JSON.stringify(i.at)}`);
  if (i.wave > i.of) throw new Error(`--wave ${i.wave} is past the run's ${i.of} waves`);
  assertApplyStatusContext(i.context);
  const status = opWaveApplyStatus(i.dirs, i.wave, i.of, i.forge.kind);
  if (!status) return `wave ${i.wave} of ${i.of} wrote no outcome, so ${i.context} stays as the wave before it left it`;
  await i.forge.setStatus(i.at, { context: i.context, state: status.state, description: status.description, ...(i.forge.runUrl ? { url: i.forge.runUrl } : {}), ...(i.pipelineId !== undefined ? { pipelineId: i.pipelineId } : {}) });
  return `${i.context} on ${i.at.slice(0, 12)}: ${status.state}: ${status.description}`;
}
