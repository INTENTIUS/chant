/**
 * `chant release evidence` (#5465): write the records of one release, or of
 * a period, into a directory with an index by control id, or check such a
 * directory. See ../../lifecycle/release-evidence.ts.
 *
 * Exits 0 when the export is written or the check finds nothing wrong, and 1
 * otherwise. An export with no release in scope is written and says so.
 */

import { resolve } from "node:path";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE =
  "chant release evidence <label|digest> -o <dir> [--sign [<key>]] [--referrers] [--sigstore] [--assets <dir>] [--json] | chant release evidence --since <date> [--until <date>] -o <dir> [...] | chant release evidence --check <dir> [--json]";

export async function runReleaseEvidence(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.check) return check(ctx);
  const ref = args.extraPositional;
  if ((ref === undefined) === (args.since === undefined)) {
    console.error(formatError({ message: "release evidence needs a release, or a period with --since", hint: USAGE }));
    return 1;
  }
  if (args.until !== undefined && args.since === undefined) {
    console.error(formatError({ message: "--until ends a period that --since starts", hint: USAGE }));
    return 1;
  }
  if (!args.output) {
    console.error(formatError({ message: "release evidence needs -o <dir>, a directory that is missing or empty", hint: USAGE }));
    return 1;
  }
  const { exportEvidence, EvidenceExportError } = await import("../../lifecycle/release-evidence");
  const scope = ref !== undefined ? ({ kind: "release", ref } as const) : ({ kind: "period", since: args.since!, until: args.until ?? new Date().toISOString() } as const);
  try {
    const { outDir, index, signedBy } = await exportEvidence({
      cwd: resolve("."),
      scope,
      outDir: args.output,
      ...(args.sign !== undefined ? { sign: args.sign } : {}),
      ...(args.referrers ? { referrers: true } : {}),
      ...(args.sigstore ? { sigstore: true } : {}),
      ...(args.assets ? { assetsDir: args.assets } : {}),
    });
    const found = index.controls.filter((c) => c.found).length;
    if (args.json) {
      console.log(JSON.stringify({ outDir, signedBy, releases: index.releases, files: index.files.length, controls: { found, of: index.controls.length }, ...(index.noReleases ? { noReleases: index.noReleases } : {}), notIncluded: index.notIncluded, problems: index.problems }, null, 2));
      return 0;
    }
    if (index.noReleases) console.error(formatWarning({ message: index.noReleases }));
    for (const r of index.releases) console.error(`  ${r.label ?? r.releaseDigest}: release verify ${r.verify}${r.sigstore ? `, sigstore ${r.sigstore}` : ""}`);
    for (const p of index.problems) console.error(formatWarning({ message: p }));
    for (const n of index.notIncluded) console.error(`  not included: ${n.what}${n.run ? ` (${n.run})` : ""}`);
    console.error(
      formatSuccess(
        `Wrote ${index.files.length} file(s) to ${outDir}. Records were found toward ${found} of ${index.controls.length} controls; index.json names them, says what they do not show, and says plainly where nothing was found${signedBy ? `. SHA256SUMS is signed by ${signedBy}` : ""}`,
      ),
    );
    console.log(outDir);
    return 0;
  } catch (err) {
    if (err instanceof EvidenceExportError) {
      if (args.json) console.log(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } }, null, 2));
      else console.error(formatError({ message: `${err.message} [${err.code}]`, ...(err.fix ? { hint: err.fix } : {}) }));
      return 1;
    }
    throw err;
  }
}

async function check(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const dir = args.extraPositional ?? args.output;
  if (!dir) {
    console.error(formatError({ message: "release evidence --check needs the export's directory", hint: USAGE }));
    return 1;
  }
  const { checkEvidence } = await import("../../lifecycle/release-evidence");
  const result = await checkEvidence(dir);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  for (const c of [...result.cuts, ...result.approvals]) console.error(`  ${c.path}:${c.line} ${c.who}: ${c.status}, ${c.reason}`);
  if (result.signature.present) console.error(`  ${result.signature.reason}`);
  else console.error("  SHA256SUMS carries no signature");
  for (const p of result.problems) console.error(formatError({ message: p }));
  if (result.ok) console.error(formatSuccess(`${result.files} file(s) match SHA256SUMS, and every signature the export holds was checked against the trust files in it`));
  return result.ok ? 0 : 1;
}
