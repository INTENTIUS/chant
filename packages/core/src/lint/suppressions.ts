/**
 * Inline HCL-comment suppression (chant #2111). This file is core's small,
 * generic half of the mechanism. It filters already-produced
 * `PostSynthDiagnostic`s against suppression directives an entity carries,
 * with no knowledge of which lexicon produced that entity. The other half,
 * reading `# chant-ignore` / `# chant-ignore-file` / `# chant-ignore-block`
 * comments out of raw `.tf` text and attaching the result to each parsed
 * entity, is terraform-specific and lives in
 * `lexicons/terraform/src/hcl/suppressions.ts`.
 *
 * Placement. The issue that asked for this weighed two options: a wrapper
 * over `runPostSynthChecks` private to the terraform lexicon, or a
 * `PostSynthContext` field every lexicon could share. Neither is quite what
 * this file does. `ctx.entities` is already the one thing every
 * `PostSynthContext` carries regardless of lexicon, and a suppression
 * directive is inherently a fact ABOUT one entity, namely which block it
 * anchors to, not a fact about the run as a whole. That is the same reasoning
 * that already lets each lexicon's `Declarable` carry its own `props` shape
 * (`TerraformEntity.props`, `K8sEntity.props`, and so on), so the hook here
 * is a plain, duck-typed optional field, `suppressions`, that any entity MAY
 * carry beside its `props`, read generically through `entitySuppressions()`
 * below. Choosing this over a `PostSynthContext.suppressions` field needed no
 * change to `PostSynthContext`, `Declarable`, or any of the places that
 * construct a context (`./post-synth.ts`'s `runPostSynthChecks`, `chant
 * audit`'s `../audit/core.ts`, and the two test-utils builders). Every one
 * of them already hands `applyInlineSuppressions` below `ctx.entities`, so a
 * lexicon that wants this (k8s manifests are the epic's other named
 * candidate) adopts the convention on its own entities, with zero further
 * core changes.
 *
 * `rules` (a project's `lint.rules`) is optional here on purpose. `chant
 * build` has one to pass, so `ignorable: false` works there; `chant audit`'s
 * audit-core path does not thread a project config through at all today, see
 * `../audit/core.ts`, so it calls this with `rules` omitted. Every rule
 * reads as ignorable in that path, the same default this module
 * gives an unconfigured rule id everywhere else.
 */

import type { RuleConfig } from "./rule";
import type { PostSynthDiagnostic } from "./post-synth";
import type { Declarable } from "../declarable";

/** What a directive's id list names. `"all"` is the wildcard every form accepts. */
export type SuppressionIds = "all" | ReadonlySet<string>;

/** One `# chant-ignore*` comment, already parsed from raw source text. */
export interface SuppressionDirective {
  /** Which of the three comment forms produced this directive. */
  form: "chant-ignore" | "chant-ignore-file" | "chant-ignore-block";
  /** Rule ids this directive names, or `"all"`. */
  ids: SuppressionIds;
  /** The `exp:YYYY-MM-DD` term, if present. */
  expires?: string;
  /** Source file the comment lives in. */
  file: string;
  /** 1-based line the comment ITSELF sits on (not the block it anchors to). */
  line: number;
  /**
   * `chant-ignore-file` is only valid as the file's first non-blank line
   * (tflint's own constraint on `tflint-ignore-file`, kept here so the form
   * stays findable). A directive found elsewhere sets this instead of being
   * applied; see `SUPPRESSION_MISPLACED_FILE_ID` below.
   */
  misplaced?: boolean;
  /**
   * Stable identity, for dedup across the several entities one directive can
   * attach to. A file-level directive attaches to every entity parsed from
   * its file, but an expired-or-misplaced report about it should appear once.
   */
  key: string;
}

/** An expired suppression is reported once as its own finding, not dropped. */
export const SUPPRESSION_EXPIRED_ID = "SUPP001";
/** A `chant-ignore-file` found anywhere but the first non-blank line. */
export const SUPPRESSION_MISPLACED_FILE_ID = "SUPP002";
/** A directive explicitly names a rule id configured `ignorable: false`. */
export const SUPPRESSION_UNIGNORABLE_ID = "SUPP003";

export type SuppressionMetaCheckId =
  | typeof SUPPRESSION_EXPIRED_ID
  | typeof SUPPRESSION_MISPLACED_FILE_ID
  | typeof SUPPRESSION_UNIGNORABLE_ID;

/**
 * A finding about the suppression mechanism itself, not about a rule id a
 * check would normally report, so it deliberately does not go through the
 * audit catalog: nothing here is registered as a `PostSynthCheck`, so it
 * never needs a `RuleMeta` entry, a lineage entry, or a full page.
 */
export interface SuppressionMetaFinding {
  checkId: SuppressionMetaCheckId;
  severity: "warning";
  message: string;
  file: string;
  line: number;
}

export interface InlineSuppressionResult {
  /** Diagnostics after inline suppression, matched ones removed. */
  diagnostics: PostSynthDiagnostic[];
  /** Diagnostics an inline directive suppressed, unaltered (counted, never dropped silently). */
  suppressed: PostSynthDiagnostic[];
  /** Findings about the suppression mechanism itself: expired, misplaced, or denied by `ignorable: false`. */
  meta: SuppressionMetaFinding[];
}

/** Read an entity's directives, if it carries any (duck-typed; see module doc). */
export function entitySuppressions(entity: Declarable | undefined): readonly SuppressionDirective[] {
  if (!entity) return [];
  const s = (entity as { suppressions?: unknown }).suppressions;
  return Array.isArray(s) ? (s as SuppressionDirective[]) : [];
}

/** Default is ignorable (per the issue); only an explicit `{ ignorable: false }` option denies it. */
function isIgnorable(rules: Record<string, RuleConfig> | undefined, id: string): boolean {
  const cfg = rules?.[id];
  if (!Array.isArray(cfg)) return true;
  const options = cfg[1] as { ignorable?: boolean } | undefined;
  return options?.ignorable !== false;
}

function namesId(ids: SuppressionIds, checkId: string): boolean {
  return ids === "all" || ids.has(checkId);
}

function isExpired(expires: string | undefined, today: Date): boolean {
  if (!expires) return false;
  const parsed = new Date(`${expires}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < today.getTime();
}

/**
 * Apply inline (`# chant-ignore*`) suppression to a set of post-synth
 * diagnostics. `entities` is `ctx.entities`, the same map every
 * `PostSynthContext` already carries. `rules` is the project's `lint.rules`,
 * for `ignorable: false`; see this module's doc comment for why it is
 * optional. `today` is injectable so an expiry test doesn't depend on the
 * clock.
 */
export function applyInlineSuppressions(
  diagnostics: readonly PostSynthDiagnostic[],
  entities: Map<string, Declarable>,
  rules?: Record<string, RuleConfig>,
  today: Date = new Date(),
): InlineSuppressionResult {
  const kept: PostSynthDiagnostic[] = [];
  const suppressed: PostSynthDiagnostic[] = [];
  const meta: SuppressionMetaFinding[] = [];
  const reported = new Set<string>();

  const reportMeta = (d: SuppressionDirective, checkId: SuppressionMetaCheckId, message: string): void => {
    const dedupeKey = `${checkId}:${d.key}`;
    if (reported.has(dedupeKey)) return;
    reported.add(dedupeKey);
    meta.push({ checkId, severity: "warning", file: d.file, line: d.line, message });
  };

  // Expired and misplaced directives are findings on their own. They don't
  // need a matching diagnostic to be worth reporting, so every directive
  // attached to any entity is checked once here, deduplicated by its own
  // identity (a directive attached to several entities, as a file-level one
  // is, would otherwise be reported once per entity).
  for (const entity of entities.values()) {
    for (const d of entitySuppressions(entity)) {
      if (d.misplaced) {
        reportMeta(
          d,
          SUPPRESSION_MISPLACED_FILE_ID,
          `chant-ignore-file at ${d.file}:${d.line} is not the first non-blank line of the file, so it has no effect. Move it to the top.`,
        );
        continue;
      }
      if (isExpired(d.expires, today)) {
        reportMeta(d, SUPPRESSION_EXPIRED_ID, `Suppression at ${d.file}:${d.line} expired ${d.expires} and no longer applies.`);
      }
    }
  }

  for (const diag of diagnostics) {
    const entity = diag.entity ? entities.get(diag.entity) : undefined;
    let matched: SuppressionDirective | undefined;
    for (const d of entitySuppressions(entity)) {
      if (d.misplaced) continue;
      if (isExpired(d.expires, today)) continue;
      if (!namesId(d.ids, diag.checkId)) continue;
      if (d.ids !== "all" && !isIgnorable(rules, diag.checkId)) {
        reportMeta(
          d,
          SUPPRESSION_UNIGNORABLE_ID,
          `${diag.checkId} is configured \`ignorable: false\`; the ${d.form} at ${d.file}:${d.line} naming it has no effect.`,
        );
        continue;
      }
      matched = d;
      break;
    }
    if (matched) suppressed.push(diag);
    else kept.push(diag);
  }

  return { diagnostics: kept, suppressed, meta };
}
