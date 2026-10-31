/**
 * The pulumi lexicon's drift read: `LexiconPlugin.readDrift`, which `chant
 * lifecycle drift` calls, and which `chant workspace drift --member <m>`
 * runs in a `pulumi` member's reader project (behold#995's command, wired
 * for Pulumi by #4455). It hands the member to the runner and adapters
 * from #4453 (`refreshPulumiMember`), so the records say exactly what those
 * adapters say.
 *
 * | engine | `--resource` | reads |
 * |---|---|---|
 * | pulumi | unset | `pulumi refresh --preview-only --json --target <urn>`, once per resource in the checked-in export; with no export, one untargeted refresh |
 * | pulumi | `<urn>` | the same, for that URN alone |
 * | plunge | unset | `plunge drift --resource <urn> --stream`, once per resource in the export |
 * | plunge | `<urn>` | the same, for that URN alone |
 *
 * Each read passes `--stack` (#4496): the stack asked for (`chant workspace
 * drift --stack`), else the member's declared `pulumi.member.stack`, else the
 * stack the export's URNs name. A stack asked for is read from that stack's
 * export in the index store alone; with none there the read is refused
 * (`no-drift-read`), where without `--stack` the member reads the store's
 * export, then the checked-in file.
 *
 * The one read is `refresh`. The member's engine is `pulumiMemberEngine`'s:
 * the member config's `engine`, then a plunge backend URL in `Pulumi.yaml`.
 * Neither command writes the stack. Each member's records go out as one
 * stream: a `drift-start` whose `expected` is every URN read, the records,
 * and a `drift-settle`. `chant workspace drift` places each record on the
 * member's graph.
 */
import type { DriftLine, DriftRecord, ReadDriftOptions, ReadDriftResult } from "@intentius/chant/drift-record";
import { driftRecordLine, driftSettle, driftStart } from "@intentius/chant/drift-record";
import type { PulumiConfig } from "./config";
import { pulumiMemberEngine, refreshPulumiMember, type PulumiRunner } from "./run";
import { readStoredPulumiExport } from "./stack-export-snapshot";
import type { SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";

/** The runners, injectable so the tests run no binary. */
export interface PulumiDriftRunners {
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  /** The index store the exports are read from. Default: the project's. */
  exportStore?: SnapshotStore | null;
}

/** `LexiconPlugin.readDrift` for the pulumi lexicon. */
export async function readPulumiDrift(options: ReadDriftOptions, runners: PulumiDriftRunners = {}): Promise<ReadDriftResult> {
  const member = (options.config as { pulumi?: PulumiConfig }).pulumi?.member;
  if (!member) return { refused: { code: "no-drift-read", message: "pulumi.member names no member; chant workspace graph writes it into a pulumi member's reader project" } };
  if (options.read !== undefined && options.read !== "refresh") {
    return { refused: { code: "read-unsupported", message: `a Pulumi member answers refresh, not ${options.read}` } };
  }
  const { engine } = pulumiMemberEngine(member.dir, member.engine);
  const stack = options.stack ?? member.stack;
  if (options.stack !== undefined) {
    const stored = await readStoredPulumiExport({ dir: member.dir, stack: options.stack, ...(runners.exportStore !== undefined ? { store: runners.exportStore } : {}) });
    if (!stored) {
      return {
        refused: {
          code: "no-drift-read",
          message: `the index store holds no export for stack ${options.stack} of ${options.member}; the pulumi-up capability writes one after each apply through chant, so apply that stack once, or read without --stack`,
        },
      };
    }
  }
  let records: DriftRecord[];
  try {
    records = await refreshPulumiMember({
      member: options.member,
      dir: member.dir,
      observedAt: options.observedAt,
      ...(member.engine ? { engine: member.engine } : {}),
      ...(stack ? { stack } : {}),
      ...(runners.exportStore !== undefined ? { exportStore: runners.exportStore } : {}),
      ...(options.resource !== undefined ? { urns: [options.resource] } : {}),
      ...(runners.run ? { run: runners.run } : {}),
      ...(runners.plunge ? { plunge: runners.plunge } : {}),
    });
  } catch (err) {
    // No URN to hang the failure on (an untargeted refresh that failed, or a plunge member with no export): the command fails with the reason.
    throw new Error(`pulumi.member ${options.member}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const start = driftStart({
    member: options.member,
    engine,
    read: "refresh",
    ...(options.resource !== undefined ? { resource: options.resource } : {}),
    at: options.observedAt,
    expected: records.map((r) => r.address),
    evidence: { tool: engine },
  });
  const settled = driftSettle(start, records, options.observedAt);
  const lines: DriftLine[] = [start, ...settled.records.map(driftRecordLine), settled.line];
  return { lines };
}
