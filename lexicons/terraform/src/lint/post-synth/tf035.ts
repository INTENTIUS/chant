/**
 * TF035: an SQS queue turns its server-side encryption off (chant #2288,
 * epic #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW026, and the case that
 * shows why the five flat rules could not be bridged. WAW026 reports a queue
 * with neither `SqsManagedSseEnabled: true` nor `KmsMasterKeyId`. Bridged onto
 * HCL, that reports every correctly encrypted queue in an estate
 * (docs/design/waw-hcl-fidelity-probe.md).
 *
 * Absence is secure for this resource, and the rule does not report it.
 * `sqs_managed_sse_enabled` is optional and computed (provider
 * `internal/service/sqs/queue.go`, v6.67.0), and the provider docs say
 * Terraform "will only perform drift detection of its value when present in
 * a configuration". Since October 2022 SQS encrypts every new queue with
 * SSE-SQS unless the request turns it off
 * (https://aws.amazon.com/blogs/compute/announcing-server-side-encryption-with-amazon-simple-queue-service-managed-encryption-keys-sse-sqs-by-default/),
 * and the provider creates queues over HTTPS, so a queue that sets neither
 * attribute is encrypted. A queue created before that date and never
 * changed can still be unencrypted; the configuration cannot show that, and
 * TF035 does not guess it.
 *
 * The finding: `sqs_managed_sse_enabled = false` with no KMS key. Present and
 * secure: `sqs_managed_sse_enabled = true`, or a `kms_master_key_id` that is
 * a non-empty literal, a managed key's attribute, or a template with literal
 * text. Not determined: `sqs_managed_sse_enabled` from an expression with no
 * key, or a key from a variable beside `sqs_managed_sse_enabled = false`.
 *
 * Scope: root and child modules alike (#2112).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { finding, notDetermined, readBool, readKeySet, resourcesOfType } from "./flat-attributes";

const ID = "TF035";

const TAIL = "TF035 does not evaluate expressions, so it cannot tell whether this queue encrypts its messages.";

export const tf035: PostSynthCheck = {
  id: "TF035",
  description: "SQS queue turns server-side encryption off",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const block of resourcesOfType(ctx, "aws_sqs_queue")) {
      const key = readKeySet(block.body, "kms_master_key_id");
      const sse = readBool(block.body, "sqs_managed_sse_enabled");
      if (key.kind === "known" && key.value !== "") continue;
      if (sse.kind === "known" && sse.value) continue;
      // Neither attribute turns encryption off: AWS's SSE-SQS default applies.
      if (sse.kind === "absent") continue;

      if (sse.kind === "unknown") {
        out.push(notDetermined(ID, block, `${sse.reason} and names no KMS key`, TAIL));
        continue;
      }
      if (key.kind === "unknown") {
        out.push(notDetermined(ID, block, `sets \`sqs_managed_sse_enabled = false\` and ${key.reason}`, TAIL));
        continue;
      }
      out.push(
        finding(
          ID,
          "warning",
          block,
          "sets `sqs_managed_sse_enabled = false` and names no KMS key, which turns off the SSE-SQS encryption AWS " +
            "applies to new queues by default, so messages are stored unencrypted. Remove the line (the default is " +
            'encrypted), set it to `true`, or set `kms_master_key_id` (`"alias/aws/sqs"` or a customer managed key).',
        ),
      );
    }
    return out;
  },
};
