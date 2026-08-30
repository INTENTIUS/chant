/**
 * Apply graduation for the strangler-fig carve (#197) — the last step.
 *
 * After a resource is emitted (`carve emit`) and the survivors are bridged
 * (`carve bridge`), it sits at the observe position: chant has the source, but
 * the live resource is an orphan carrying no chant ownership. Graduation is the
 * dial-turn to apply: mark the resource chant-owned so `chant carve` / status
 * recognize it, and finalize the ordered apply runbook.
 *
 * This is BYOL-honest: it does NOT call the cloud. It resolves the ownership
 * marker (reusing core's `ownershipEntries`) and produces the graduation
 * artifacts + runbook. The apply itself is whatever lifecycle you brought —
 * the native CLI, a CI pipeline, an ApplyOp — and it stamps the marker the
 * emitted source now carries.
 */

import { ownershipEntries, LABEL_OWNERSHIP_KEYS, type ChannelKeys, type OwnershipMarker } from "../ownership";
import type { CarveReport } from "./carve";

/**
 * Default tag channel, mirroring the AWS lexicon's `AWS_TAG_OWNERSHIP_KEYS`
 * (`lexicons/aws/src/ownership.ts`). Core cannot import a lexicon, so the
 * convention is duplicated here; the values match so the graduation plan shows
 * the tags the AWS apply path will actually stamp.
 */
export const DEFAULT_TAG_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant:managed-by",
  stack: "chant:stack",
  env: "chant:env",
};

export interface GraduationPlan {
  target: string;
  marker: OwnershipMarker;
  /** The ownership entries the emitted resource must carry to be chant-owned. */
  ownershipTags: Record<string, string>;
  /** What that channel is called on this target: `tags`, or `labels` for k8s. */
  markerKind: string;
  /** The finalized, ordered apply runbook. */
  steps: string[];
  warnings: string[];
}

export interface GraduationOptions {
  /** Chant stack name for the ownership marker (defaults to the resource name). */
  stack?: string;
  /** Environment identity for the marker. */
  env?: string;
  /** Override the tag channel (e.g. for a non-AWS lexicon). */
  channel?: ChannelKeys;
  /**
   * The lexicon the emitted source targets, from the carve provider that
   * adopted the type. It decides how the build and the apply are spelled: a
   * CloudFormation template and `aws cloudformation deploy` for aws, a manifest
   * and `kubectl apply` for k8s (#999). Unknown falls back to the aws wording,
   * which is what every carve was before there was a second provider.
   */
  lexicon?: string;
}

/**
 * How the marker, the build output and the BYOL apply are spelled, per emitted
 * lexicon. A Kubernetes object carries the marker as labels — the same
 * `LABEL_OWNERSHIP_KEYS` the k8s serializer merges in — so a runbook promising
 * `chant:managed-by` tags would name a channel nothing stamps.
 */
function applyVocabulary(
  lexicon: string | undefined,
  target: string,
  stack: string,
): { channel: ChannelKeys; markerKind: string; build: string; apply: string } {
  if (lexicon === "k8s") {
    return {
      channel: LABEL_OWNERSHIP_KEYS,
      markerKind: "labels",
      build: `chant build <emitted-src> --lexicon k8s > ${target}.yaml`,
      apply: `kubectl apply -f ${target}.yaml`,
    };
  }
  return {
    channel: DEFAULT_TAG_OWNERSHIP_KEYS,
    markerKind: "tags",
    build: `chant build <emitted-src> -o ${target}.template.json`,
    apply: `aws cloudformation deploy --template-file ${target}.template.json --stack-name ${stack} ...`,
  };
}

export function graduationPlan(report: CarveReport, opts: GraduationOptions = {}): GraduationPlan {
  const stack = opts.stack ?? (report.target.split(".").slice(1).join(".") || report.target);
  const marker: OwnershipMarker = { stack, env: opts.env };
  const vocabulary = applyVocabulary(opts.lexicon, report.target, stack);
  const ownershipTags = ownershipEntries(opts.channel ?? vocabulary.channel, marker);

  const warnings: string[] = [];
  if (report.outbound.length) {
    warnings.push(
      `${report.outbound.length} deferred deploy-time input(s) must be wired before apply (see the boundary report).`,
    );
  }

  const tagList = Object.entries(ownershipTags)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  const steps = [
    `1. Confirm the emitted source builds spec-true:  ${vocabulary.build}`,
    `2. Add the ownership marker so chant owns the resource — ${vocabulary.markerKind}: ${tagList}`,
    `3. Apply with your lifecycle (BYOL), e.g.:`,
    `     ${vocabulary.apply}`,
    `   or graduate to an ApplyOp for a durable, gated apply.`,
    `4. Verify chant now owns it:  chant lifecycle diff --live <env>   (expect: unchanged, owned)`,
    `Rollback before this point:  terraform import ${report.target} <physical-id>`,
  ];

  return { target: report.target, marker, ownershipTags, markerKind: vocabulary.markerKind, steps, warnings };
}

/**
 * A constructor-shaped emitted file: `export const x = new Ctor(`. Tag-based
 * ownership is a property of that shape — a carved `kubernetes_manifest` is a
 * `k8sManifest({ ... })` call whose props are the manifest, where a top-level
 * `Tags` array would be an invented field on the object, not a marker (#999).
 * Such a file is refused rather than stamped.
 */
const CONSTRUCTOR_SHAPE = /^export const \w+ = new \w+\(/m;

/**
 * Stamp the ownership tags into an emitted chant source file (`carve apply
 * --write-source`). The emitted source is machine-generated (`adoptFromState`),
 * so its shape is known: one prop per line, `Tags` as a single-line JSON array.
 * Merges into an existing `Tags` prop (replacing stale chant keys) or inserts
 * one into the constructor's props object. Returns null when the file has no
 * recognizable constructor to stamp.
 */
export function stampOwnershipIntoSource(
  content: string,
  tags: Record<string, string>,
): { content: string; changed: boolean } | null {
  if (!CONSTRUCTOR_SHAPE.test(content)) return null;
  const entries = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  const keys = new Set(Object.keys(tags));
  const lines = content.split("\n");

  // Merge into an existing Tags prop.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)Tags: (\[.*\]),$/);
    if (!m) continue;
    let existing: Array<{ Key: string; Value: unknown }>;
    try {
      existing = JSON.parse(m[2]) as Array<{ Key: string; Value: unknown }>;
    } catch {
      continue;
    }
    const merged = [...existing.filter((t) => !keys.has(t.Key)), ...entries];
    const rendered = `${m[1]}Tags: ${JSON.stringify(merged)},`;
    if (rendered === lines[i]) return { content, changed: false };
    lines[i] = rendered;
    return { content: lines.join("\n"), changed: true };
  }

  // No Tags prop yet: insert one into the constructor's props object.
  const tagsLine = `  Tags: ${JSON.stringify(entries)},`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\}\);\s*$/.test(lines[i])) {
      lines.splice(i, 0, tagsLine);
      return { content: lines.join("\n"), changed: true };
    }
    const empty = lines[i].match(/^(export const .+ = new \w+\()\{\}(\);)\s*$/);
    if (empty) {
      lines[i] = `${empty[1]}{\n${tagsLine}\n}${empty[2]}`;
      return { content: lines.join("\n"), changed: true };
    }
  }
  return null;
}
