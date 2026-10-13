/**
 * TF034: an SNS topic has no server-side encryption (chant #2288, epic #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW025, written natively.
 *
 * Absence is insecure for this resource, and the rule reports it.
 * `aws_sns_topic.kms_master_key_id` (provider `internal/service/sns/topic.go`,
 * v6.67.0) is optional with no default, and SNS has no service-owned
 * encryption that applies when no key is named: server-side encryption
 * (https://docs.aws.amazon.com/sns/latest/dg/sns-server-side-encryption.html)
 * is on only when the topic names a KMS key, either the AWS managed
 * `alias/aws/sns` or a customer managed key. Unlike SQS (TF035), no AWS
 * default turns it on for new topics. A literal `kms_master_key_id = ""`
 * names no key and is the same finding.
 *
 * Present and secure: a non-empty literal, an attribute of a managed resource
 * or data source (`aws_kms_key.sns.arn`, `aws_kms_alias.sns.arn`), or a
 * template with literal text. Not determined: a variable, local, module
 * output, conditional or function call, any of which can be `null` or `""`.
 *
 * Scope: root and child modules alike (#2112).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { finding, notDetermined, readKeySet, resourcesOfType } from "./flat-attributes";

const ID = "TF034";

export const tf034: PostSynthCheck = {
  id: "TF034",
  description: "SNS topic has no server-side encryption",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const block of resourcesOfType(ctx, "aws_sns_topic")) {
      const key = readKeySet(block.body, "kms_master_key_id");
      if (key.kind === "known" && key.value !== "") continue;
      if (key.kind === "unknown") {
        out.push(
          notDetermined(
            ID,
            block,
            key.reason,
            "TF034 does not evaluate expressions, so it cannot tell whether this names a KMS key or is null.",
          ),
        );
        continue;
      }
      const how = key.kind === "absent" ? "does not set `kms_master_key_id`" : 'sets `kms_master_key_id = ""`';
      out.push(
        finding(
          ID,
          "warning",
          block,
          `${how}, so SNS stores its messages without server-side encryption; no AWS default encrypts a topic that ` +
            'names no key. Set `kms_master_key_id` to a customer managed key, or to `"alias/aws/sns"` for the AWS ' +
            "managed one.",
        ),
      );
    }
    return out;
  },
};
