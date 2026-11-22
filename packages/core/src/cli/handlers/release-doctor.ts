/**
 * `chant release doctor [--json]` (#5161): before a cut, ask each target
 * `release.publish` declares whether publishing from this environment can
 * succeed. See ../../lifecycle/release-doctor.ts for the checks.
 *
 * Exits 1 when any check fails, and 0 otherwise, including when a check
 * can't tell from here.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatBold, formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";
import type { DoctorReport, DoctorStatus } from "../../lifecycle/release-doctor";

const USAGE = "chant release doctor [--from cut] [--json]";

/** The release workflow file from the repository root: `release.workflow.file` in the workspace root's config, or the forge's default. */
async function releaseWorkflowFile(cwd: string): Promise<string | null> {
  const { findWorkspaceRoot } = await import("../../project-root");
  const { gitTop } = await import("../../workspace/tree");
  const { RELEASE_WORKFLOW_FILES } = await import("../../workspace/release-workflow");
  const root = realpathSync(findWorkspaceRoot(cwd)?.dir ?? cwd);
  const repoRoot = gitTop(root) ?? root;
  let file: string | undefined;
  try {
    const { loadChantConfig } = await import("../../config");
    file = (await loadChantConfig(root)).config.release?.workflow?.file;
  } catch {
    file = undefined;
  }
  if (file) return file;
  const forge = existsSync(join(repoRoot, ".github", "workflows")) ? "github" : existsSync(join(repoRoot, ".forgejo", "workflows")) ? "forgejo" : existsSync(join(repoRoot, ".gitlab-ci.yml")) ? "gitlab" : "github";
  // GitLab's trusted publishers name the top-level pipeline file, which includes chant's.
  return forge === "gitlab" ? ".gitlab-ci.yml" : RELEASE_WORKFLOW_FILES[forge];
}

/** The green gate the cut would check (#5149), resolved as the cut resolves it. */
async function greenGate(cwd: string, declared: import("../../lifecycle/release-green").ReleaseGreenSource | undefined): Promise<import("../../lifecycle/release-green").ReleaseGreenSource> {
  const { resolveGreenSource } = await import("../../lifecycle/release-green");
  if (declared !== undefined) return declared;
  const { scopeSource } = await import("../../workspace/write-scope");
  const { execFileSync } = await import("node:child_process");
  let ciGreen = false;
  try {
    ciGreen = (scopeSource(cwd).declaration?.ci?.green ?? null) !== null;
  } catch {
    ciGreen = false;
  }
  let tags = "";
  try {
    tags = execFileSync("git", ["tag", "--list", "ci/green/*", "ci/green-*/*"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    tags = "";
  }
  return resolveGreenSource(undefined, ciGreen, tags !== "");
}

const MARK: Record<DoctorStatus, string> = { ok: "ok        ", warn: "warn      ", fail: "FAIL      ", unknown: "can't tell" };

export function formatDoctorReport(report: DoctorReport): string[] {
  const e = report.environment;
  const where = e.ci === "github" ? `GitHub Actions${e.workflow ? `, ${e.workflow}` : ""}` : e.ci === "gitlab" ? "GitLab CI" : e.ci === "other" ? "CI" : "a workstation";
  const lines = [
    `Release doctor, from ${where}${e.from === "cut" ? ", the cut job" : ""}: OIDC ${e.oidc ? "yes" : "no"}; the release workflow is ${e.releaseWorkflow ?? "not known"}${e.repository ? ` in ${e.repository}` : ""}`,
  ];
  for (const t of report.targets) {
    lines.push(formatBold(t.name));
    for (const c of t.checks) {
      lines.push(`  ${MARK[c.status]}  ${c.check}: ${c.message}`);
      if (c.fix && c.status !== "ok") lines.push(`              fix: ${c.fix}`);
    }
  }
  const n = report.counts;
  lines.push(`${n.ok} ok, ${n.warn} warning(s), ${n.fail} failed, ${n.unknown} can't be observed from here`);
  return lines;
}

export async function runReleaseDoctor(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(".");
  const from = ctx.args.migrateFrom;
  if (from !== undefined && from !== "cut") {
    console.error(formatError({ message: `--from ${from} is not a job the doctor knows: the release workflow's cut job is --from cut [doctor-from-invalid]`, hint: USAGE }));
    return 1;
  }
  let publish: import("../../lifecycle/publish-declaration").PublishDeclaration[];
  let declaredGreen: import("../../lifecycle/release-green").ReleaseGreenSource | undefined;
  let signing: import("../../lifecycle/publish-signing").SigningConfig | undefined;
  let scan: import("../../lifecycle/publish-scan").ReleaseScanConfig | undefined;
  let scanner: "grype" | "trivy" | undefined;
  try {
    const { loadChantConfig } = await import("../../config");
    const config = (await loadChantConfig(cwd)).config;
    const release = config.release;
    publish = release?.publish ?? [];
    declaredGreen = release?.green;
    signing = release?.signing;
    scan = release?.scan;
    scanner = config.vulnPolicy?.scanner;
  } catch (err) {
    console.error(formatError({ message: `release.publish in chant.config.ts could not be read: ${err instanceof Error ? err.message : String(err)} [doctor-config-invalid]`, hint: USAGE }));
    return 1;
  }
  const { releaseDoctor } = await import("../../lifecycle/release-doctor");
  // #5164: the security groups decide whether the publish signs, as they do for the publish.
  let groups: ReadonlySet<import("../../workspace/security").SecurityGroup> = new Set();
  try {
    const { scopeSource } = await import("../../workspace/write-scope");
    const { securityGroupsIn } = await import("../../workspace/security");
    groups = securityGroupsIn(scopeSource(cwd), cwd);
  } catch {
    groups = new Set();
  }
  const report = await releaseDoctor({ cwd, publish, releaseWorkflow: await releaseWorkflowFile(cwd), ...(from === "cut" ? { from } : {}), green: await greenGate(cwd, declaredGreen), ...(signing !== undefined ? { signing } : {}), ...(scan !== undefined ? { scan } : {}), ...(scanner ? { scanner } : {}), groups });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.targets.length === 0) {
    console.log("Nothing to check: this member declares no publish target (release.publish in chant.config.ts).");
  } else {
    for (const line of formatDoctorReport(report)) console.log(line);
    if (report.counts.fail === 0) console.log(formatSuccess("No check failed."));
  }
  return report.counts.fail > 0 ? 1 : 0;
}
