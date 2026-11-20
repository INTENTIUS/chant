/**
 * A wave's soak in front of the next wave (#5326).
 *
 * Wave `k`'s job reads the soak wave `k - 1` declares, before it plans. The
 * clock starts at that wave's newest apply on the run ledger (the run
 * records `chant run wave` appends under the spec's name): each target it
 * applied is a member that applied at the record's end. While the soak
 * holds, the job records the pending fact of gate `<gate>-wave-<k-1>-soak`
 * under the spec's name and exits 3 with the time left, so the waves after
 * it wait as they do for a gate. Running the job again reads the clock and
 * the checks again; approving that gate ends the soak early. The wave's own
 * gate still decides after it.
 *
 * A canary wave (#5327, `OpWave.canary`, the first wave) holds every wave
 * after it, not only the next: each later wave's job reads the canary's
 * soak through the same gate, `<gate>-wave-1-soak`, before the soak of the
 * wave just before it. It is one soak with one clock and one early end.
 */

import { createHash } from "node:crypto";
import { fetchLifecycle } from "../lifecycle/git";
import { DEFAULT_RUN_ENV, readRunLedger } from "../lifecycle/run-ledger";
import { activeProductWords } from "../ci-product-words";
import { gitGateLedgerPort, type GateLedgerPort } from "./gate";
import { opWaveGateName, type OpWavesSpec } from "./op-waves";
import type { OpRunRecord } from "./runtime";
import { soakAtGate, waveSoakGate, type SoakGateOutcome } from "../pipeline/soak-gate";
import { soakCheckReader } from "../pipeline/soak-checks";
import { jobSoakSources } from "../pipeline/soak-sources";
import type { SoakCheckReader, SoakSubject } from "../pipeline/soak";

/** What the wave that soaks applied: the members and when, and the digest an early end binds; null when the ledger has no run of it. */
export interface WaveSoakApplied {
  subjects: SoakSubject[];
  digest: string;
}

/** The test seams of a wave's soak. */
export interface OpWaveSoakOptions {
  read?: SoakCheckReader;
  applied?: (wave: number) => Promise<WaveSoakApplied | null>;
  now?: Date;
}

/** The newest run of wave `k` of `spec` on the run records: its applied targets at the record's end, and the set digest it applied under. */
export function waveSoakAppliedFrom(records: readonly OpRunRecord[], spec: Pick<OpWavesSpec, "name">, k: number): WaveSoakApplied | null {
  const runs = records
    .filter((r) => r.wave?.spec === spec.name && r.wave.number === k && (r.wave.applied.length > 0 || r.wave.failed.length > 0 || r.wave.exitCode === 0))
    .sort((a, b) => Date.parse(a.ended) - Date.parse(b.ended));
  const newest = runs.at(-1);
  if (!newest?.wave) return null;
  const w = newest.wave;
  const subjects = w.applied.map((t) => ({ member: t, targets: [t], appliedAt: newest.ended }));
  const digest = w.digest ?? `sha256:${createHash("sha256").update(JSON.stringify([spec.name, k, newest.ended, [...w.applied].sort()])).digest("hex")}`;
  return { subjects, digest };
}

/**
 * The waves whose soak wave `k`'s job reads before it plans, 1-based, in
 * order: the canary wave (#5327) when wave `k` comes after it, and the wave
 * just before `k` when it declares a soak (#5326). One wave is read once,
 * through its one gate, so the canary's soak right before wave 2 is the
 * same hold wave 3 reads.
 */
export function opWaveSoaksBefore(spec: Pick<OpWavesSpec, "waves">, k: number): number[] {
  const out: number[] = [];
  const canary = spec.waves[0]?.canary === true && spec.waves[0].soak !== undefined ? 1 : undefined;
  if (canary !== undefined && k > canary) out.push(canary);
  if (k > 1 && spec.waves[k - 2]?.soak !== undefined && !out.includes(k - 1)) out.push(k - 1);
  return out;
}

/**
 * The soaks in front of wave `k` ({@link opWaveSoaksBefore}): undefined when
 * there is none or each passed, else the result the job ends with (exit 3)
 * for the first that holds. `log` gets each line.
 */
export async function opWaveSoakStop(
  input: { spec: OpWavesSpec; k: number; cwd: string; gates?: GateLedgerPort; soak?: OpWaveSoakOptions; log: (line: string) => void },
): Promise<SoakGateOutcome | undefined> {
  for (const j of opWaveSoaksBefore(input.spec, input.k)) {
    const held = await waveSoakStop(input, j);
    if (held) return held;
  }
  return undefined;
}

/** The soak of wave `j` in front of wave `k`. */
async function waveSoakStop(
  input: { spec: OpWavesSpec; k: number; cwd: string; gates?: GateLedgerPort; soak?: OpWaveSoakOptions; log: (line: string) => void },
  j: number,
): Promise<SoakGateOutcome | undefined> {
  const { spec, k, cwd, log } = input;
  const before = spec.waves[j - 1];
  if (!before?.soak) return undefined;
  const what = `wave ${j} (${before.name})${before.canary ? ", the canary," : ""}`;
  const env = spec.labels?.Env ?? DEFAULT_RUN_ENV;
  const applied = input.soak?.applied
    ? await input.soak.applied(j)
    : await (async () => {
        await fetchLifecycle({ cwd }).catch(() => false);
        return waveSoakAppliedFrom((await readRunLedger(env, spec.name, { cwd })).records, spec, j);
      })();
  if (applied && applied.subjects.length === 0) {
    log(`${what} applied nothing on its last run, so it has nothing to soak`);
    return undefined;
  }
  const words = activeProductWords();
  const outcome = await soakAtGate({
    op: spec.name,
    gate: waveSoakGate(opWaveGateName(spec, j)),
    soak: before.soak,
    stage: env,
    holds: `wave ${k} (${spec.waves[k - 1]?.name ?? k})`,
    wave: j,
    digest: applied?.digest ?? `sha256:${createHash("sha256").update(JSON.stringify([spec.name, j, "no-run"])).digest("hex")}`,
    subjects: applied?.subjects ?? [],
    port: input.gates ?? gitGateLedgerPort({ cwd }),
    read: input.soak?.read ?? soakCheckReader(jobSoakSources({ op: spec.name, cwd })),
    now: input.soak?.now ?? new Date(),
    ...(spec.notify ? { notify: { config: spec.notify, source: words.notify.source, project: spec.name } } : {}),
  });
  if (outcome.passed) {
    for (const line of outcome.lines) log(`wave ${k}: ${line}`);
    return undefined;
  }
  log(`wave ${k}: ${outcome.message}`);
  log(`wave ${k}: ${outcome.hint}`);
  return outcome;
}
