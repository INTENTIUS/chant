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
 * Checks that read `ctx.entities` instead of `ctx.outputs` normally will not
 * fire on audited YAML — the security tier is YAML-based, so this is by
 * design. The exception is a lexicon that ships `auditEntities` (#1567):
 * its classified files are parsed back into the entity graph (parse-to-graph),
 * so the same graph-reading checks that fire on `chant build` fire on the
 * audit too, with no output-reading rule variants to drift.
 */

import { basename } from "path";
import type { Severity } from "../lint/rule";
import type { PostSynthCheck, PostSynthContext } from "../lint/post-synth";
import type { SerializerResult } from "../serializer";
import type { LexiconPlugin } from "../lexicon";
import type { Declarable } from "../declarable";

/**
 * The lexicon whose post-synth checks run against an audited file. Any lexicon
 * name is accepted — `defaultChecksProvider` loads the plugin by name — so a
 * caller can audit a lexicon outside the built-in set. The listed names are the
 * ones with built-in content detection (see `discover.ts`), kept here only for
 * editor autocomplete; `(string & {})` keeps the union open.
 */
export type AuditLexicon =
  | "github"
  | "gitlab"
  | "forgejo"
  | "k8s"
  | "docker"
  | "aws"
  | "azure"
  | "gcp"
  | "helm"
  | "fountain"
  | (string & {});

/** A single CI file to audit. */
export interface AuditInput {
  /** Path used to tag findings (e.g. ".github/workflows/ci.yml"). */
  path: string;
  /** Raw content of the file. */
  content: string;
  /** Which lexicon's checks to run against it. */
  lexicon: AuditLexicon;
  /**
   * Bundle inputs (e.g. a Helm chart) supply a files map keyed by relative path
   * — checks that read `output.files` (helm, docker) see the whole bundle.
   */
  files?: Record<string, string>;
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
  /** 1-based line number within `file`, when the check can pin one (e.g. secrets detection, #443). */
  line?: number;
  /**
   * A redaction-safe fingerprint of the flagged value (see
   * `secrets.ts`'s `fingerprintSecret`), so a finding can be referenced —
   * for an allowlist entry, for dedup — without ever carrying the value
   * itself.
   */
  fingerprint?: string;
}

/**
 * Resolve the post-synth checks for a lexicon. Injectable so the core can be
 * unit-tested without loading real lexicon packages.
 */
export type ChecksProvider = (lexicon: AuditLexicon) => Promise<PostSynthCheck[]>;

/**
 * Parse one classified file's content into the lexicon's entity graph — the
 * parse-to-graph half of the audit (#1567). The returned map is what
 * `ctx.entities` holds during a build, so entity-reading checks run unchanged.
 */
export type EntitiesParser = (content: string) => Map<string, Declarable>;

/**
 * Resolve the entities parser for a lexicon (its plugin's `auditEntities`,
 * when it ships one). Injectable so the core can be unit-tested without
 * loading real lexicon packages.
 */
export type EntitiesProvider = (lexicon: AuditLexicon) => Promise<EntitiesParser | undefined>;

const checksCache = new Map<AuditLexicon, PostSynthCheck[]>();
const entitiesParserCache = new Map<AuditLexicon, EntitiesParser | undefined>();

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

async function load(names: string[]): Promise<LexiconPlugin[]> {
  try {
    // Lazy import so that merely importing `auditFiles` doesn't pull in
    // `cli/plugins` -> config loader -> the TypeScript compiler. A caller that
    // supplies its own `checksProvider` (e.g. an edge/bundled deployment) never
    // reaches this and never bundles that graph. See #408.
    const { loadPlugins } = await import("../cli/plugins");
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
 * Default provider for the parse-to-graph half (#1567): a lexicon that ships
 * `auditEntities` gets its classified files parsed into `ctx.entities`. A
 * lexicon without the hook (or one that fails to load — the checks provider
 * already surfaced that) simply audits with an empty entity graph, as before.
 */
async function defaultEntitiesProvider(lexicon: AuditLexicon): Promise<EntitiesParser | undefined> {
  if (entitiesParserCache.has(lexicon)) return entitiesParserCache.get(lexicon);
  let parser: EntitiesParser | undefined;
  try {
    const [plugin] = await load([lexicon]);
    const parse = plugin?.auditEntities?.bind(plugin);
    if (parse) parser = parse;
  } catch {
    parser = undefined;
  }
  entitiesParserCache.set(lexicon, parser);
  return parser;
}

/**
 * Audit a set of CI files and return all findings. Pure with respect to the
 * filesystem and network — callers supply file contents.
 */
export async function auditFiles(
  inputs: AuditInput[],
  opts: { checksProvider?: ChecksProvider; entitiesProvider?: EntitiesProvider } = {},
): Promise<AuditFinding[]> {
  const provider = opts.checksProvider ?? defaultChecksProvider;
  const entitiesProvider = opts.entitiesProvider ?? defaultEntitiesProvider;
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
    const parseEntities = await entitiesProvider(lexicon);
    findings.push(...auditLexicon(lexicon, files, checks, parseEntities));
  }

  return findings;
}

/** Label for findings that span more than one file (e.g. duplicate names). */
export const CROSS_FILE = "(cross-file)";

/**
 * Each file as its own serialized output. Most lexicons get a SerializerResult
 * (primary + basename-keyed files; docker filters `files` by name). The gcp
 * checks require the output to be a raw string (`typeof output === "string"`),
 * so gcp gets the content directly.
 */
function toOutput(file: AuditInput): string | SerializerResult {
  if (file.files) return { primary: file.content, files: file.files };
  if (file.lexicon === "gcp") return file.content;
  return { primary: file.content, files: { [basename(file.path)]: file.content } };
}

function runChecks(
  checks: PostSynthCheck[],
  outputs: Map<string, string | SerializerResult>,
  entities: Map<string, Declarable> = new Map(),
): ReturnType<PostSynthCheck["check"]> {
  const buildResult: PostSynthContext["buildResult"] = { outputs, entities, warnings: [], errors: [], sourceFileCount: outputs.size };
  const ctx: PostSynthContext = { outputs, entities: buildResult.entities, buildResult };
  const diags = [];
  for (const check of checks) {
    try {
      diags.push(...check.check(ctx));
    } catch {
      // A check that throws on unusual external YAML must not abort the audit.
    }
  }
  return diags;
}

function diagKey(d: { checkId: string; entity?: string; message: string }): string {
  return `${d.checkId} ${d.entity ?? ""} ${d.message}`;
}

/**
 * Merge per-file entity maps into one graph for the all-files pass. A key
 * collision (the same entity name declared in two files) gets a `#n` suffix —
 * so no declaration is silently dropped and duplicate-name checks keep both
 * in view.
 */
function mergeEntities(maps: Array<Map<string, Declarable>>): Map<string, Declarable> {
  const merged = new Map<string, Declarable>();
  for (const m of maps) {
    for (const [key, entity] of m) {
      let k = key;
      for (let n = 2; merged.has(k); n++) k = `${key}#${n}`;
      merged.set(k, entity);
    }
  }
  return merged;
}

/**
 * Audit one lexicon's files with cross-file awareness.
 *
 * Two passes:
 *  - **all-files** (every file in one context) is the source of truth — it lets
 *    relational checks resolve (an Application sees its AppProject elsewhere; a
 *    duplicate name is seen across files) and clears single-file false positives.
 *  - **per-file** supplies the file each finding belongs to.
 *
 * A per-file finding is kept only if it survives in the all-files pass (drops
 * cross-file-resolved false positives). An all-files finding with no per-file
 * match is a genuine cross-file finding, labelled `CROSS_FILE`.
 *
 * When the lexicon supplies an entities parser (#1567), each pass also carries
 * the entity graph parsed from its files — per file for the per-file pass, all
 * files merged for the all-files pass — so entity-reading checks fire and
 * cross-file facts (an Agent's Environment declared elsewhere, a name declared
 * twice across the apply directory) resolve in the all-files pass.
 */
function auditLexicon(lexicon: AuditLexicon, files: AuditInput[], checks: PostSynthCheck[], parseEntities?: EntitiesParser): AuditFinding[] {
  const entitiesFor = (file: AuditInput): Map<string, Declarable> => {
    if (!parseEntities) return new Map();
    try {
      return parseEntities(file.content);
    } catch {
      // The audit contract is "runs against any repo" — unparseable content
      // contributes no entities, never a crash.
      return new Map();
    }
  };
  const perEntities = new Map(files.map((f) => [f.path, entitiesFor(f)]));

  const perFindings: AuditFinding[] = [];
  const perKeys = new Set<string>();
  for (const file of files) {
    const diags = runChecks(checks, new Map([[file.path, toOutput(file)]]), perEntities.get(file.path));
    for (const d of diags) {
      perFindings.push({ checkId: d.checkId, severity: d.severity, message: d.message, file: file.path, lexicon: d.lexicon ?? lexicon, entity: d.entity });
      perKeys.add(diagKey(d));
    }
  }

  const allOutputs = new Map<string, string | SerializerResult>(files.map((f) => [f.path, toOutput(f)]));
  const allDiags = runChecks(checks, allOutputs, mergeEntities([...perEntities.values()]));
  const allKeys = new Set(allDiags.map(diagKey));

  const out: AuditFinding[] = perFindings.filter((f) => allKeys.has(diagKey(f)));
  for (const d of allDiags) {
    if (!perKeys.has(diagKey(d))) {
      out.push({ checkId: d.checkId, severity: d.severity, message: d.message, file: CROSS_FILE, lexicon: d.lexicon ?? lexicon, entity: d.entity });
    }
  }
  return out;
}
