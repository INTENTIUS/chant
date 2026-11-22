/**
 * The scan at the cut (#5446, epic #5452): the scan `chant release publish`
 * runs before the stage (./publish-scan.ts), run by `chant release cut` on
 * what the publish would put out, before the release is signed, written to
 * `chant/lifecycle`, pushed or tagged. A release the scan refuses spends no
 * label: no tag names it and no cut line records it.
 *
 * It scans what the publish scans, from the same context
 * (./publish-scan-context.ts): each `oci` target's archive (the cut has just
 * built the `release.images` ones) through an SBOM of its layers, the SBOM
 * each `forge` target attaches, and the SBOM each npm package carries or one
 * written from the lockfile; with the project's `vulnPolicy` and VEX files,
 * grype or trivy (the Wiz image scanner when `release.scan.imageScanner`
 * asks), and the database age bound of `release.scan.dbMaxAgeHours` or a
 * security profile. The refusals keep the publish's codes, as the cut's other
 * early runs of a publish target's check do (`publish-npm-carries-image`,
 * `publish-npm-never-published`): `publish-scan-failed`,
 * `publish-scan-db-stale`, `publish-scan-tool-missing`,
 * `publish-scan-tool-failed`, `publish-scan-vex-missing`.
 *
 * A target whose subjects can't be read at the cut for a reason that is not
 * the scan's, such as a file only the publish job builds, is left to the
 * publish's scan, with a line saying so. The publish scans again either way:
 * later, maybe with a newer database, and for a release cut anywhere.
 */

import type { ScanContext, ScanReport } from "./publish-scan";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishTarget } from "./release-publish";
import type { Release } from "./release-store";
import { ReleaseCutError, type ReleaseCutCode } from "./release-cut";

/** What a cut scans with, resolved before anything is built. */
export interface CutScan {
  scan: ScanContext;
  /** The `release.publish` targets, as the publish makes them. */
  targets: PublishTarget[];
}

/** The fix a cut refused for a stale database prints. */
const CUT_DB_STALE_FIX =
  "Update the scanner's database in the job before the cut (grype db update, or trivy with its database download on), or refresh the directory release.scan.db names, then cut again. Nothing was recorded or tagged, so the label is not spent.";

/**
 * Whether the cut of the member at `cwd` scans, and with what: null when
 * `release.scan` and the `supply-chain` group leave it off, or no target has
 * anything to scan. Throws {@link ReleaseCutError} when the scanner can't run
 * (`publish-scan-tool-missing`), a VEX file is not there
 * (`publish-scan-vex-missing`), or the targets can't be read
 * (`publish-config-invalid`), so the cut stops before it builds anything.
 */
export async function prepareCutScan(req: { cwd: string; label: string | null; env: NodeJS.ProcessEnv; deps?: PublishDeps }): Promise<CutScan | null> {
  const { loadChantConfig } = await import("../config");
  const { scopeSource } = await import("../workspace/write-scope");
  const { securityGroupsIn } = await import("../workspace/security");
  const { resolveScan } = await import("./publish-scan");
  const config = (await loadChantConfig(req.cwd, { fresh: true })).config;
  const source = scopeSource(req.cwd);
  const groups = securityGroupsIn(source, req.cwd);
  // A project that does not scan reads nothing more, so its cut is what it was.
  if (!resolveScan(config.release?.scan, groups).on) return null;
  let targets: PublishTarget[];
  try {
    const { createPublishTargets } = await import("./publish-targets");
    targets = await createPublishTargets(config.release?.publish ?? [], req.deps ?? {});
  } catch (err) {
    throw new ReleaseCutError("publish-config-invalid", `no release was cut: the publish targets can't be read: ${err instanceof Error ? err.message : String(err)}`, "Fix release.publish in chant.config.ts.");
  }
  const { resolveScanContext } = await import("./publish-scan-context");
  const resolved = await resolveScanContext({
    cwd: req.cwd,
    name: req.label ?? "the release",
    targets,
    config,
    groups,
    declaration: source.declaration,
    env: req.env,
    ...(req.deps?.releaseScanner ? { scanner: req.deps.releaseScanner } : {}),
  });
  if ("refusal" in resolved) throw new ReleaseCutError(resolved.refusal.code, `no release was cut: ${resolved.refusal.message}`, resolved.refusal.fix);
  return resolved.scan ? { scan: resolved.scan, targets } : null;
}

/**
 * Scan what the publish of `release` would put out. Returns the report when
 * no finding blocks; throws {@link ReleaseCutError} with the publish's code
 * when one does, when the database is older than the bound, or when the
 * scanner fails.
 */
export async function scanAtCut(
  plan: CutScan,
  req: { release: Release; label: string | null; cwd: string; env: NodeJS.ProcessEnv; log: (line: string) => void; now: () => Date },
): Promise<ScanReport> {
  const { createRedactor } = await import("./publish-credentials");
  const { detectProvenance } = await import("./release-publish");
  const { blockingLines, PublishScanError, scanBeforeStage } = await import("./publish-scan");
  const redactor = createRedactor(req.env, plan.targets.flatMap((t) => t.credentialEnv));
  const say = (line: string) => req.log(redactor.redact(line));
  const ctx: PublishContext = {
    release: req.release,
    label: req.label,
    releaseTag: await releaseTagOf(req.cwd, req.label),
    provenance: detectProvenance(req.env),
    cut: null,
    cwd: req.cwd,
    tag: null,
    env: req.env,
    redactor,
    log: say,
    // A package with no SBOM of its own is scanned through its lockfile here; the publish refuses it, if it must.
    requireSbom: false,
    scan: plan.scan,
  };
  // A target that can't name its subjects for a reason that is not the scan's is the publish's to refuse.
  const targets = plan.targets
    .filter((t) => t.scanSubjects)
    .map(
      (t): PublishTarget => ({
        ...t,
        scanSubjects: async (c: PublishContext) => {
          try {
            return await t.scanSubjects!.call(t, c);
          } catch (err) {
            if (!(err instanceof PublishTargetError) || err.code.startsWith("publish-scan-")) throw err;
            say(`  ${t.name}: not scanned at the cut, so the publish scans it: ${err.message} [${err.code}]`);
            return [];
          }
        },
      }),
    );
  say(`  scanning with ${plan.scan.scanner.name} before anything is recorded or tagged`);
  let report: ScanReport;
  try {
    report = await scanBeforeStage({ targets, ctx, scan: plan.scan, say });
  } catch (err) {
    if (err instanceof PublishScanError) {
      const lines = err.report.subjects.flatMap(blockingLines);
      throw new ReleaseCutError(
        "publish-scan-failed",
        redactor.redact(`no release was cut: ${err.report.scanner} found ${lines.length} finding(s) the vulnerability policy blocks, so nothing was recorded, tagged or pushed:\n    ${lines.join("\n    ")}`),
        "Fix the dependency or the base image and cut again, or record a VEX statement in a file vulnPolicy.vexSources names when it is not exploitable. vulnPolicy in chant.config.ts sets what blocks. The label is not spent.",
      );
    }
    if (err instanceof PublishTargetError) throw new ReleaseCutError(err.code as ReleaseCutCode, redactor.redact(`no release was cut: ${err.message}`), err.fix);
    throw err;
  }
  // #5464: a database older than the bound refuses the cut, as it refuses the publish.
  if (plan.scan.dbAge) {
    const { scanDatabaseStale } = await import("../workspace/security-profiles");
    const stale = scanDatabaseStale(report.database, plan.scan.dbAge, req.now());
    if (stale) throw new ReleaseCutError("publish-scan-db-stale", `no release was cut: ${stale}, so nothing was recorded, tagged or pushed`, CUT_DB_STALE_FIX);
  }
  return report;
}

/** The tag `release.tag` gives `label`, for the names a forge target's subjects carry; null when there is none or it can't be read. */
async function releaseTagOf(cwd: string, label: string | null): Promise<string | null> {
  if (label === null) return null;
  try {
    const { memberTags, renderReleaseTag } = await import("./release-tag");
    const tags = await memberTags(cwd);
    return renderReleaseTag(tags.template, tags.place, label);
  } catch {
    return null;
  }
}
