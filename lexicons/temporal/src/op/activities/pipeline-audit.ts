/**
 * pipelineSupplyChainAudit — the live counterpart to the gitlab post-synth
 * include/component/image checks (#297).
 *
 * Some include/component checks can only be answered against a moving external
 * truth: whether a pinned component/include ref still resolves upstream, whether
 * the upstream project was archived or moved, or whether a new advisory now
 * covers a component/image already in use. These change independent of the
 * source, so they cannot live in the deterministic build — this activity owns
 * *only* the checks that require live resolution.
 *
 * Dependency-free and primitives-only: it reads the emitted `.gitlab-ci.yml`
 * (passed as a string) and resolves references through an injectable
 * `GitlabRefResolver`, so Temporal/`chant run` can schedule it and tests can run
 * it against recorded responses with no live network.
 */

/** What the audit produces on findings. For GitLab the PR mode is a merge request. */
export type PipelineAuditMode = "report" | "issue" | "merge-request";

/** The kind of reference being resolved. */
export type PipelineRefKind = "include" | "component" | "image";

/** Live resolution of a single pipeline reference against its upstream. */
export interface PipelineRefResolution {
  /** Does the project/component/image (at this ref/version) still resolve? */
  exists: boolean;
  /** Has the upstream project been archived? */
  archived: boolean;
  /** Has the upstream project moved (new path), if known. */
  movedTo?: string;
  /** Disclosed advisory identifiers affecting this reference. */
  advisories: string[];
}

/** Pluggable upstream resolver — overridden in tests with recorded responses. */
export type GitlabRefResolver = (kind: PipelineRefKind, identifier: string, ref: string) => Promise<PipelineRefResolution>;

export type PipelineAuditFindingKind = "unresolved" | "archived" | "moved" | "advisory";

export interface PipelineAuditFinding {
  kind: PipelineAuditFindingKind;
  refKind: PipelineRefKind;
  /** project path / component address / image. */
  identifier: string;
  /** ref / version / tag. */
  ref: string;
  detail: string;
}

export interface PipelineAuditArgs {
  /** One emitted `.gitlab-ci.yml` document. */
  yaml?: string;
  /** Several emitted documents. */
  yamls?: string[];
  /** Path to an emitted `.gitlab-ci.yml` to read at run time (default `.gitlab-ci.yml`). */
  pipelineFile?: string;
  /** What to produce. Default: report. */
  mode?: PipelineAuditMode;
  /** Injectable upstream resolver. Defaults to the live GitLab REST resolver. */
  resolver?: GitlabRefResolver;
}

export interface PipelineAuditResult {
  mode: PipelineAuditMode;
  findings: PipelineAuditFinding[];
  summary: string;
}

interface CollectedRef {
  refKind: PipelineRefKind;
  identifier: string;
  ref: string;
}

/**
 * Collect `include:project` (+ ref), `component:` (with @version), and `image:`
 * references from a `.gitlab-ci.yml`.
 */
export function collectPipelineRefs(yaml: string): CollectedRef[] {
  const out: CollectedRef[] = [];

  // include:\n  - project: group/proj\n    ref: main
  const projectRe = /-\s+project:\s*['"]?([^\s'"]+)['"]?[\s\S]*?ref:\s*['"]?([^\s'"]+)['"]?/g;
  let m: RegExpExecArray | null;
  while ((m = projectRe.exec(yaml)) !== null) {
    out.push({ refKind: "include", identifier: m[1], ref: m[2] });
  }

  // - component: host/group/comp@1.0.0
  const componentRe = /-\s+component:\s*['"]?([^\s'"@]+)@([^\s'"]+)['"]?/g;
  while ((m = componentRe.exec(yaml)) !== null) {
    out.push({ refKind: "component", identifier: m[1], ref: m[2] });
  }

  // Images: inline `image: name` or block `image:\n  name: ...` (and services).
  const lines = yaml.split("\n");
  const imgSeen = new Set<string>();
  const addImage = (raw: string) => {
    const image = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!image || image.includes("$") || imgSeen.has(image)) return;
    imgSeen.add(image);
    const at = image.lastIndexOf("@");
    const colon = image.lastIndexOf(":");
    const ref = at !== -1 ? image.slice(at + 1) : colon > image.lastIndexOf("/") ? image.slice(colon + 1) : "latest";
    out.push({ refKind: "image", identifier: image, ref });
  };
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^\s+image:[ \t]+(\S.*)$/);
    if (inline) { addImage(inline[1]); continue; }
    if (/^\s+image:\s*$/.test(lines[i]) || /^\s+-\s+name:[ \t]+(\S.*)$/.test(lines[i])) {
      const svcName = lines[i].match(/^\s+-\s+name:[ \t]+(\S.*)$/);
      if (svcName) { addImage(svcName[1]); continue; }
      const nameLine = lines.slice(i + 1, i + 4).find((l) => /^\s+name:[ \t]+/.test(l));
      if (nameLine) addImage(nameLine.replace(/^\s+name:[ \t]+/, ""));
    }
  }

  return out;
}

/**
 * Default resolver: query the GitLab REST API for project existence / archive /
 * move status. Best-effort and resilient — errors yield an "unknown" resolution
 * (exists=true, no findings) rather than a false positive. Component/image
 * advisory lookups are left to a configured resolver.
 */
export const defaultGitlabRefResolver: GitlabRefResolver = async (kind, identifier) => {
  const unknown: PipelineRefResolution = { exists: true, archived: false, advisories: [] };
  if (kind === "image") return unknown; // image advisory feeds are resolver-specific
  const host = "https://gitlab.com";
  const project = kind === "component" ? identifier.split("/").slice(1, 3).join("/") : identifier;
  try {
    const resp = await fetch(`${host}/api/v4/projects/${encodeURIComponent(project)}`, {
      headers: process.env.GITLAB_TOKEN ? { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN } : {},
    });
    if (resp.status === 404) return { exists: false, archived: false, advisories: [] };
    if (!resp.ok) return unknown;
    const p = (await resp.json()) as { archived?: boolean };
    return { exists: true, archived: !!p.archived, advisories: [] };
  } catch {
    return unknown;
  }
};

function renderSummary(findings: PipelineAuditFinding[]): string {
  if (findings.length === 0) return "## Pipeline include/component audit\n\nNo live drift detected against upstream references.\n";
  let out = `## Pipeline include/component audit\n\n${findings.length} finding(s) against live upstream truth:\n\n`;
  out += "| Reference | Ref | Finding | Detail |\n|---|---|---|---|\n";
  for (const f of findings) out += `| ${f.identifier} (${f.refKind}) | ${f.ref} | ${f.kind} | ${f.detail} |\n`;
  return out;
}

async function readFileBestEffort(path: string): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    return [await readFile(path, "utf-8")];
  } catch {
    return [];
  }
}

/**
 * Resolve each include/component/image reference in the emitted pipeline against
 * live upstreams and report drift.
 */
export async function pipelineSupplyChainAudit(args: PipelineAuditArgs): Promise<PipelineAuditResult> {
  const resolver = args.resolver ?? defaultGitlabRefResolver;
  const mode = args.mode ?? "report";
  let yamls = args.yamls ?? (args.yaml ? [args.yaml] : []);
  if (yamls.length === 0) {
    yamls = await readFileBestEffort(args.pipelineFile ?? ".gitlab-ci.yml");
  }

  const findings: PipelineAuditFinding[] = [];
  const seen = new Set<string>();
  for (const yaml of yamls) {
    for (const { refKind, identifier, ref } of collectPipelineRefs(yaml)) {
      const key = `${refKind}:${identifier}@${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const res = await resolver(refKind, identifier, ref);
      if (!res.exists) {
        findings.push({ kind: "unresolved", refKind, identifier, ref, detail: `${refKind} "${identifier}@${ref}" no longer resolves upstream` });
        continue;
      }
      if (res.archived) {
        findings.push({ kind: "archived", refKind, identifier, ref, detail: `${identifier} has been archived upstream` });
      }
      if (res.movedTo) {
        findings.push({ kind: "moved", refKind, identifier, ref, detail: `${identifier} moved to ${res.movedTo}` });
      }
      for (const adv of res.advisories) {
        findings.push({ kind: "advisory", refKind, identifier, ref, detail: `disclosed advisory ${adv} covers ${identifier}` });
      }
    }
  }

  return { mode, findings, summary: renderSummary(findings) };
}
