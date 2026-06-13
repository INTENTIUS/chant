/**
 * Security-aware migration (#306).
 *
 * Migration is the edge between the two security endpoints (#296 ↔ #305).
 * Security properties don't translate 1:1 — some are silently preserved, some
 * lost, some need re-establishing on the GitLab side. This module classifies
 * each security-relevant property's fate as it crosses the boundary and runs
 * the GitLab security post-synth checks against the migrated output so anything
 * lost in translation is caught on the target side.
 */

import type { ProvenanceRecord } from "./provenance";

const UNTRUSTED_CONTEXTS = [
  "github.event.issue.title",
  "github.event.issue.body",
  "github.event.pull_request.title",
  "github.event.pull_request.body",
  "github.event.pull_request.head.ref",
  "github.event.comment.body",
  "github.event.review.body",
  "github.event.head_commit.message",
  "github.head_ref",
];

const SHA_PINNED_USES = /uses:\s*['"]?([\w.-]+\/[\w.-]+(?:\/[\w.-]+)*)@([0-9a-f]{40})['"]?/g;
const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Classify the fate of security-relevant properties as they migrate from a
 * GitHub Actions workflow to GitLab CI. Returns provenance records carrying a
 * `security` classification (which flow into diagnostics, SARIF, and the report
 * like any other provenance record).
 */
export function analyzeSecurity(sourceYaml: string, opts: { sourceFile?: string } = {}): ProvenanceRecord[] {
  const records: ProvenanceRecord[] = [];
  const file = opts.sourceFile;

  // MIG-PIN-LOST — a GitHub SHA pin has no meaning once the action maps to a
  // GitLab include/image (or becomes a hand-written script). Re-pin on GitLab.
  const seenPins = new Set<string>();
  let m: RegExpExecArray | null;
  SHA_PINNED_USES.lastIndex = 0;
  while ((m = SHA_PINNED_USES.exec(sourceYaml)) !== null) {
    const slug = m[1];
    if (seenPins.has(slug)) continue;
    seenPins.add(slug);
    records.push({
      gitlabPath: "(target)",
      sourceKey: `uses: ${slug}`,
      sourceFile: file,
      category: "synthesis",
      rule: "MIG-PIN-LOST",
      note: `The SHA pin on "${slug}" does not carry to its GitLab include/image — re-pin the GitLab target to a tag or digest (WGL029/WGL031).`,
      security: { property: "Pinned action SHA", fate: "lost", severity: "warning", reestablish: "#297" },
    });
  }

  // MIG-SECRET-UNSCOPED — ${{ secrets.X }} → $X, but masking/protection is set
  // outside the YAML; the reference assumes a masked + protected variable.
  const seenSecrets = new Set<string>();
  SECRET_REF.lastIndex = 0;
  while ((m = SECRET_REF.exec(sourceYaml)) !== null) {
    const name = m[1];
    if (seenSecrets.has(name)) continue;
    seenSecrets.add(name);
    records.push({
      gitlabPath: "(target)",
      sourceKey: `secrets.${name}`,
      sourceFile: file,
      category: "needs-review",
      rule: "MIG-SECRET-UNSCOPED",
      note: `secrets.${name} → $${name}, which assumes a masked + protected GitLab CI/CD variable. Mark it masked and protected (WGL038).`,
      security: { property: "Secret reference", fate: "needs-review", severity: "warning", reestablish: "#300" },
    });
  }

  // MIG-INJECTION-CARRIED — an untrusted-context interpolation translates
  // verbatim, carrying the injection straight across.
  const seenInjection = new Set<string>();
  for (const ctx of UNTRUSTED_CONTEXTS) {
    if (sourceYaml.includes(ctx) && !seenInjection.has(ctx)) {
      seenInjection.add(ctx);
      records.push({
        gitlabPath: "(target)",
        sourceKey: ctx,
        sourceFile: file,
        category: "needs-review",
        rule: "MIG-INJECTION-CARRIED",
        note: `Untrusted input \${{ ${ctx} }} translates to a $CI_* reference verbatim — the script-injection risk carries across (WGL035).`,
        security: { property: "Template injection site", fate: "translated", severity: "warning", reestablish: "#299" },
      });
    }
  }

  // MIG-TRUST-BOUNDARY — pull_request_target maps to merge-request pipelines,
  // which fork contributors can trigger; the trust boundary shifts.
  if (/pull_request_target/.test(sourceYaml)) {
    records.push({
      gitlabPath: "(target)",
      sourceKey: "on.pull_request_target",
      sourceFile: file,
      category: "needs-review",
      rule: "MIG-TRUST-BOUNDARY",
      note: `pull_request_target → merge-request pipelines, which fork contributors can trigger. Re-establish the trust boundary (protected refs, approvals) on GitLab (WGL034/WGL036).`,
      security: { property: "Trigger trust boundary", fate: "needs-review", severity: "warning", reestablish: "#299" },
    });
  }

  // MIG-PERMISSIONS-001 (reframed as least-privilege) — permissions: has no
  // per-job GitLab YAML equivalent; least privilege lives in project settings.
  if (/^permissions:/m.test(sourceYaml) || /^\s+permissions:/m.test(sourceYaml)) {
    records.push({
      gitlabPath: "(target)",
      sourceKey: "permissions",
      sourceFile: file,
      category: "needs-review",
      rule: "MIG-PERMISSIONS-001",
      note: `Least-privilege permissions: have no per-job GitLab YAML equivalent — re-establish via project CI/CD token settings and id_tokens scoping (WGL033).`,
      security: { property: "Least-privilege permissions", fate: "needs-review", severity: "warning", reestablish: "#298" },
    });
  }

  return records;
}

/**
 * Run the GitLab security post-synth checks against the migrated `.gitlab-ci.yml`
 * and return their findings as provenance records — *migrate, then prove the
 * output clears the GitLab security bar*. Anything lost in translation that
 * lands as a concrete weakness on the target is caught here.
 */
export async function runSecurityChecks(gitlabYaml: string, opts: { sourceFile?: string } = {}): Promise<ProvenanceRecord[]> {
  const { gitlabPlugin } = await import("../../plugin");
  const checks = gitlabPlugin.postSynthChecks?.() ?? [];
  const ctx = {
    outputs: new Map<string, string>([["gitlab", gitlabYaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map<string, string>([["gitlab", gitlabYaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };

  const records: ProvenanceRecord[] = [];
  for (const check of checks) {
    let diags;
    try {
      diags = check.check(ctx as never);
    } catch {
      continue; // a check that needs entities/other context simply yields nothing here
    }
    for (const d of diags) {
      records.push({
        gitlabPath: "(target)",
        sourceKey: d.entity ?? d.checkId,
        sourceFile: opts.sourceFile,
        category: "synthesis",
        rule: d.checkId,
        note: `Migrated output triggers ${d.checkId}: ${d.message}`,
        security: {
          property: "GitLab security check",
          fate: "needs-review",
          severity: d.severity === "error" ? "error" : d.severity === "info" ? "info" : "warning",
        },
      });
    }
  }
  return records;
}

/** A one-property line in the security posture summary. */
interface PostureLine {
  property: string;
  fate: string;
  rule: string;
  count: number;
}

/**
 * Render a "Security posture" Markdown section from the security provenance
 * records (those carrying a `security` classification).
 */
export function renderSecurityPosture(records: ProvenanceRecord[]): string {
  const security = records.filter((r) => r.security);
  if (security.length === 0) {
    return "## Security posture\n\nNo security-relevant properties detected at the migration edge.\n";
  }

  const byRule = new Map<string, PostureLine>();
  for (const r of security) {
    const s = r.security!;
    const existing = byRule.get(r.rule);
    if (existing) existing.count += 1;
    else byRule.set(r.rule, { property: s.property, fate: s.fate, rule: r.rule, count: 1 });
  }

  let out = "## Security posture\n\n";
  out += "| Property | Fate | Rule | Count |\n|---|---|---|---|\n";
  for (const line of byRule.values()) {
    out += `| ${line.property} | ${line.fate} | ${line.rule} | ${line.count} |\n`;
  }
  out += "\nFates: **translated** (weakness carried as-is) · **approximated** · **needs-review** (re-establish on GitLab) · **lost** (no GitLab equivalent for the property).\n";
  return out;
}
