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
 * The soak of the wave before wave `k`: undefined when it declares none or
 * passed, else the result the job ends with (exit 3). `log` gets each line.
 */
export async function opWaveSoakStop(
  input: { spec: OpWavesSpec; k: number; cwd: string; gates?: GateLedgerPort; soak?: OpWaveSoakOptions; log: (line: string) => void },
): Promise<SoakGateOutcome | undefined> {
  const { spec, k, cwd, log } = input;
  const before = k > 1 ? spec.waves[k - 2] : undefined;
  if (!before?.soak) return undefined;
  const env = spec.labels?.Env ?? DEFAULT_RUN_ENV;
  const applied = input.soak?.applied
    ? await input.soak.applied(k - 1)
    : await (async () => {
        await fetchLifecycle({ cwd }).catch(() => false);
        return waveSoakAppliedFrom((await readRunLedger(env, spec.name, { cwd })).records, spec, k - 1);
      })();
  if (applied && applied.subjects.length === 0) {
    log(`wave ${k - 1} (${before.name}) applied nothing on its last run, so it has nothing to soak`);
    return undefined;
  }
  const words = activeProductWords();
  const outcome = await soakAtGate({
    op: spec.name,
    gate: waveSoakGate(opWaveGateName(spec, k - 1)),
    soak: before.soak,
    stage: env,
    holds: `wave ${k} (${spec.waves[k - 1]?.name ?? k})`,
    wave: k - 1,
    digest: applied?.digest ?? `sha256:${createHash("sha256").update(JSON.stringify([spec.name, k - 1, "no-run"])).digest("hex")}`,
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
