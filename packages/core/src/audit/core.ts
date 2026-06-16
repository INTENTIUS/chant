/**
 * Audit core — run chant's CI security checks against arbitrary repo YAML.
 *
 * The post-synth security checks (`lexicons/<lex>/src/lint/post-synth/*.ts`)
 * read the emitted workflow YAML from `ctx.outputs`, not the chant model
 * (`ctx.entities`). So an auditor can feed *existing* repo YAML straight in as
 * a synthetic output and run the real rules — no import-to-chant-model step.
 *
 * Each file is audited as its own `primary` output so single-document security
 * checks (the merge-worthy tier: permissions, pinning, injection, secrets)
 * fire on every workflow. Cross-file checks (e.g. duplicate workflow names)
 * only see one file at a time here; that is acceptable because the security
 * tier is per-document.
 *
 * Checks that read `ctx.entities` instead of `ctx.outputs` will not fire on
 * audited YAML — the security tier is YAML-based, so this is by design.
 */

import type { Severity } from "../lint/rule";
import type { PostSynthCheck, PostSynthContext } from "../lint/post-synth";
import type { SerializerResult } from "../serializer";
import { loadPlugins } from "../cli/plugins";

/** Lexicons whose post-synth checks the auditor knows how to run. */
export type AuditLexicon = "github" | "gitlab" | "forgejo" | "k8s";

/** A single CI file to audit. */
export interface AuditInput {
  /** Path used to tag findings (e.g. ".github/workflows/ci.yml"). */
  path: string;
  /** Raw YAML content of the file. */
  content: string;
  /** Which lexicon's checks to run against it. */
  lexicon: AuditLexicon;
}

/** A finding produced by a post-synth check against an audited file. */
export interface AuditFinding {
  checkId: string;
  severity: Severity;
  message: string;
  /** The audited file this finding came from. */
  file: string;
  /** The lexicon that produced the finding. */
  lexicon: string;
  /** Optional entity (e.g. job name) the check attached. */
  entity?: string;
}

/**
 * Resolve the post-synth checks for a lexicon. Injectable so the core can be
 * unit-tested without loading real lexicon packages.
 */
export type ChecksProvider = (lexicon: AuditLexicon) => Promise<PostSynthCheck[]>;

const checksCache = new Map<AuditLexicon, PostSynthCheck[]>();

function dedupeById(checks: PostSynthCheck[]): PostSynthCheck[] {
  const byId = new Map<string, PostSynthCheck>();
  for (const check of checks) {
    if (!byId.has(check.id)) byId.set(check.id, check);
  }
  return [...byId.values()];
}

/**
 * Default provider: load the lexicon plugin(s) and return their post-synth
 * checks. Forgejo workflows are GitHub-dialect YAML, so the GitHub security
 * tier is run against them in addition to Forgejo's own checks.
 */
/** Thrown when a lexicon package the audit needs isn't installed. */
export class MissingLexiconError extends Error {}

async function load(names: string[]): Promise<Awaited<ReturnType<typeof loadPlugins>>> {
  try {
    return await loadPlugins(names);
  } catch (err) {
    const pkgs = names.map((n) => `@intentius/chant-lexicon-${n}`).join(" ");
    throw new MissingLexiconError(
      `Missing lexicon package needed to audit ${names.join("/")} workflows. Install it with: npm i ${pkgs}\n(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function defaultChecksProvider(lexicon: AuditLexicon): Promise<PostSynthCheck[]> {
  const cached = checksCache.get(lexicon);
  if (cached) return cached;

  let checks: PostSynthCheck[];
  if (lexicon === "forgejo") {
    const [forgejo, github] = await load(["forgejo", "github"]);
    checks = dedupeById([
      ...(forgejo?.postSynthChecks?.() ?? []),
      ...(github?.postSynthChecks?.() ?? []),
    ]);
  } else {
    const [plugin] = await load([lexicon]);
    checks = plugin?.postSynthChecks?.() ?? [];
  }

  checksCache.set(lexicon, checks);
  return checks;
}

/**
 * Audit a set of CI files and return all findings. Pure with respect to the
 * filesystem and network — callers supply file contents.
 */
export async function auditFiles(
  inputs: AuditInput[],
  opts: { checksProvider?: ChecksProvider } = {},
): Promise<AuditFinding[]> {
  const provider = opts.checksProvider ?? defaultChecksProvider;
  const findings: AuditFinding[] = [];

  // Group by lexicon so each plugin's checks are resolved once.
  const byLexicon = new Map<AuditLexicon, AuditInput[]>();
  for (const input of inputs) {
    const list = byLexicon.get(input.lexicon) ?? [];
    list.push(input);
    byLexicon.set(input.lexicon, list);
  }

  for (const [lexicon, files] of byLexicon) {
    const checks = await provider(lexicon);
    if (checks.length === 0) continue;

    for (const file of files) {
      const output: SerializerResult = {
        primary: file.content,
        files: { [file.path]: file.content },
      };
      const buildResult: PostSynthContext["buildResult"] = {
        outputs: new Map<string, string | SerializerResult>([[lexicon, output]]),
        entities: new Map(),
        warnings: [],
        errors: [],
        sourceFileCount: 1,
      };
      const ctx: PostSynthContext = {
        outputs: buildResult.outputs,
        entities: buildResult.entities,
        buildResult,
      };

      for (const check of checks) {
        let diags;
        try {
          diags = check.check(ctx);
        } catch {
          // A check that throws on unusual external YAML must not abort the
          // whole audit. Skip it and keep going.
          continue;
        }
        for (const d of diags) {
          findings.push({
            checkId: d.checkId,
            severity: d.severity,
            message: d.message,
            file: file.path,
            lexicon: d.lexicon ?? lexicon,
            entity: d.entity,
          });
        }
      }
    }
  }

  return findings;
}
