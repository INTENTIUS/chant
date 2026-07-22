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

import { ownershipEntries, type ChannelKeys, type OwnershipMarker } from "../ownership";
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
  /** The ownership tags the emitted resource must carry to be chant-owned. */
  ownershipTags: Record<string, string>;
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
}

export function graduationPlan(report: CarveReport, opts: GraduationOptions = {}): GraduationPlan {
  const stack = opts.stack ?? (report.target.split(".").slice(1).join(".") || report.target);
  const marker: OwnershipMarker = { stack, env: opts.env };
  const ownershipTags = ownershipEntries(opts.channel ?? DEFAULT_TAG_OWNERSHIP_KEYS, marker);

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
    `1. Confirm the emitted source builds spec-true:  chant build <emitted-src> -o ${report.target}.template.json`,
    `2. Add the ownership marker so chant owns the resource — tags: ${tagList}`,
    `3. Apply with your lifecycle (BYOL), e.g.:`,
    `     aws cloudformation deploy --template-file ${report.target}.template.json --stack-name ${stack} ...`,
    `   or graduate to an ApplyOp for a durable, gated apply.`,
    `4. Verify chant now owns it:  chant lifecycle diff --live <env>   (expect: unchanged, owned)`,
    `Rollback before this point:  terraform import ${report.target} <physical-id>`,
  ];

  return { target: report.target, marker, ownershipTags, steps, warnings };
}
