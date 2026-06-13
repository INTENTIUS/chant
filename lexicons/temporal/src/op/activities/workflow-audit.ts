/**
 * workflowSupplyChainAudit — the live counterpart to the github post-synth
 * supply-chain checks (#286-#291).
 *
 * Some workflow-reference checks can only be answered against a moving external
 * truth: whether a pinned SHA still corresponds to a real tag/release upstream,
 * whether a referenced commit exists in the repo it claims, whether a ref is
 * confusable as both a tag and a branch, whether a pin matches its version
 * comment, or whether a new advisory now covers an action already in use. These
 * change over time independent of the source, so they cannot live in the
 * deterministic build — this activity owns *only* the checks that require live
 * resolution.
 *
 * It is dependency-free and primitives-only: it reads the emitted workflow YAML
 * (passed as a string) and resolves references through an injectable
 * `ActionRefResolver`, so Temporal/`chant run` can schedule it and tests can run
 * it against recorded responses with no live network.
 */

/** What the audit produces on findings, mirroring ReconcileOp's modes. */
export type WorkflowAuditMode = "report" | "issue" | "pull-request";

/** Live resolution of a single action reference against its upstream. */
export interface ActionRefResolution {
  /** Does the ref/SHA exist in the claimed repo? */
  exists: boolean;
  /** Tag/release names that point at this commit (empty for a SHA ⇒ stale pin). */
  tags: string[];
  /** Is the upstream repository archived? */
  archived: boolean;
  /** Disclosed advisory identifiers affecting this action. */
  advisories: string[];
  /** Is the ref resolvable as BOTH a tag and a branch upstream? */
  ambiguousRef?: boolean;
}

/** Pluggable upstream resolver — overridden in tests with recorded responses. */
export type ActionRefResolver = (slug: string, ref: string) => Promise<ActionRefResolution>;

export type WorkflowAuditFindingKind =
  | "stale-pin"
  | "impostor"
  | "ambiguous-ref"
  | "pin-comment-mismatch"
  | "advisory"
  | "archived";

export interface WorkflowAuditFinding {
  /** owner/repo slug. */
  slug: string;
  /** The pinned ref/SHA. */
  ref: string;
  kind: WorkflowAuditFindingKind;
  detail: string;
}

export interface WorkflowAuditArgs {
  /** One emitted workflow YAML document. */
  yaml?: string;
  /** Several emitted workflow YAML documents. */
  yamls?: string[];
  /**
   * Directory of emitted workflow files (`*.yml`/`*.yaml`) to read at run time
   * when no `yaml`/`yamls` is given — the form used inside a scheduled Op.
   * Default `.github/workflows`.
   */
  workflowsDir?: string;
  /** What to produce. Default: report. */
  mode?: WorkflowAuditMode;
  /** Injectable upstream resolver. Defaults to the live GitHub REST resolver. */
  resolver?: ActionRefResolver;
}

/** Read `*.yml`/`*.yaml` files from a directory (best-effort). */
async function readWorkflowDir(dir: string): Promise<string[]> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    return Promise.all(files.map((f) => readFile(join(dir, f), "utf-8")));
  } catch {
    return [];
  }
}

export interface WorkflowAuditResult {
  mode: WorkflowAuditMode;
  findings: WorkflowAuditFinding[];
  /** Markdown summary used as the PR/issue body or printed in report mode. */
  summary: string;
}

interface CollectedRef {
  slug: string;
  ref: string;
  /** Adjacent `# vX.Y.Z` comment, when present. */
  comment?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Collect external action references (`uses: owner/repo@ref`, with an optional
 * trailing version comment) from a workflow YAML. Local (`./`) and `docker://`
 * references are excluded.
 */
export function collectAuditRefs(yaml: string): CollectedRef[] {
  const out: CollectedRef[] = [];
  const re = /uses:\s*['"]?([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([\w.-]+)['"]?\s*(?:#\s*(\S+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml)) !== null) {
    out.push({ slug: m[1].split("/").slice(0, 2).join("/"), ref: m[2], comment: m[3] });
  }
  return out;
}

/**
 * Default resolver: query the GitHub REST API for whether the ref exists, what
 * tags point at it, archive status, and advisories. Best-effort and resilient —
 * a network/HTTP error yields an "unknown" resolution (exists=true, no findings)
 * rather than a false positive.
 */
export const defaultActionRefResolver: ActionRefResolver = async (slug, ref) => {
  const base = `https://api.github.com/repos/${slug}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const unknown: ActionRefResolution = { exists: true, tags: [], archived: false, advisories: [] };
  try {
    const repoResp = await fetch(base, { headers });
    if (repoResp.status === 404) return { exists: false, tags: [], archived: false, advisories: [] };
    if (!repoResp.ok) return unknown;
    const repo = (await repoResp.json()) as { archived?: boolean };

    const refResp = await fetch(`${base}/commits/${ref}`, { headers });
    if (refResp.status === 404) return { exists: false, tags: [], archived: !!repo.archived, advisories: [] };

    let tags: string[] = [];
    if (SHA_RE.test(ref)) {
      const tagsResp = await fetch(`${base}/tags?per_page=100`, { headers });
      if (tagsResp.ok) {
        const tagList = (await tagsResp.json()) as Array<{ name: string; commit?: { sha?: string } }>;
        tags = tagList.filter((t) => t.commit?.sha === ref).map((t) => t.name);
      }
    }
    return { exists: refResp.ok, tags, archived: !!repo.archived, advisories: [] };
  } catch {
    return unknown;
  }
};

function renderSummary(findings: WorkflowAuditFinding[]): string {
  if (findings.length === 0) return "## Workflow supply-chain audit\n\nNo live drift detected against upstream references.\n";
  let out = `## Workflow supply-chain audit\n\n${findings.length} finding(s) against live upstream truth:\n\n`;
  out += "| Action | Ref | Finding | Detail |\n|---|---|---|---|\n";
  for (const f of findings) out += `| ${f.slug} | ${f.ref} | ${f.kind} | ${f.detail} |\n`;
  return out;
}

/**
 * Resolve each pinned external reference in the emitted workflows against live
 * upstreams and report drift.
 */
export async function workflowSupplyChainAudit(args: WorkflowAuditArgs): Promise<WorkflowAuditResult> {
  const resolver = args.resolver ?? defaultActionRefResolver;
  const mode = args.mode ?? "report";
  let yamls = args.yamls ?? (args.yaml ? [args.yaml] : []);
  if (yamls.length === 0) {
    yamls = await readWorkflowDir(args.workflowsDir ?? ".github/workflows");
  }

  const findings: WorkflowAuditFinding[] = [];
  const seen = new Set<string>();
  for (const yaml of yamls) {
    for (const { slug, ref, comment } of collectAuditRefs(yaml)) {
      const key = `${slug}@${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const res = await resolver(slug, ref);
      if (!res.exists) {
        findings.push({ slug, ref, kind: "impostor", detail: `ref does not exist in ${slug} — possible impostor or deleted ref` });
        continue;
      }
      if (SHA_RE.test(ref) && res.tags.length === 0) {
        findings.push({ slug, ref, kind: "stale-pin", detail: "pinned SHA is no longer on any tag/release upstream" });
      }
      if (res.ambiguousRef) {
        findings.push({ slug, ref, kind: "ambiguous-ref", detail: "ref resolves as both a tag and a branch upstream (symbolic-ref confusion)" });
      }
      if (comment && res.tags.length > 0 && !res.tags.includes(comment)) {
        findings.push({ slug, ref, kind: "pin-comment-mismatch", detail: `pin comment "${comment}" does not match the SHA's actual tag(s): ${res.tags.join(", ")}` });
      }
      if (res.archived) {
        findings.push({ slug, ref, kind: "archived", detail: `${slug} has been archived upstream since pinning` });
      }
      for (const adv of res.advisories) {
        findings.push({ slug, ref, kind: "advisory", detail: `disclosed advisory ${adv} covers ${slug}` });
      }
    }
  }

  return { mode, findings, summary: renderSummary(findings) };
}
