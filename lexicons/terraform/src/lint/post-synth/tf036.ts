/**
 * TF036: an EBS volume does not ask for encryption (chant #2288, epic #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW028, written natively.
 *
 * Absence is not determined for this resource. `aws_ebs_volume.encrypted` is
 * optional, computed and force-new (provider `internal/service/ec2/
 * ebs_volume.go`, v6.67.0). Whether a volume created without it is encrypted
 * depends on the Region's EBS encryption by default
 * (https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html),
 * which is account state the parse cannot see, and a volume built from
 * `snapshot_id` also follows its snapshot. So an unset `encrypted` emits one
 * `info` diagnostic, not a finding.
 *
 * One configuration does settle absence: the volume `depends_on` an
 * `aws_ebs_encryption_by_default` in the same module whose `enabled` is
 * absent (the provider default is `true`) or literal `true`, on the same
 * `provider` and `region`. The `depends_on` matters: without it Terraform may
 * create the volume before it turns the default on, and the default "has no
 * effect on existing EBS volumes".
 *
 * `encrypted = false` is a finding even though encryption by default would
 * override it. The literal is wrong either way: with the default off the
 * volume is unencrypted, and with it on AWS encrypts the volume anyway ("you
 * cannot disable it for individual volumes"), the volume no longer matches
 * the configuration, and because `encrypted` forces replacement Terraform
 * plans to replace it on every apply.
 *
 * Scope: root and child modules alike (#2112).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { scopeOfKey } from "../../hcl/parse";
import type { TerraformBlock } from "./blocks";
import { finding, isGiven, notDetermined, readBool, resourcesOfType } from "./flat-attributes";

const ID = "TF036";
const DEFAULT_TYPE = "aws_ebs_encryption_by_default";

/** The `aws_ebs_encryption_by_default.<name>` addresses a volume's `depends_on` names. */
function dependsOnDefaults(block: TerraformBlock): string[] {
  const deps = block.body.depends_on;
  if (!Array.isArray(deps)) return [];
  const out: string[] = [];
  for (const d of deps) {
    if (typeof d !== "string") continue;
    const m = /^\$\{\s*(aws_ebs_encryption_by_default\.[A-Za-z_][\w-]*)\s*\}$/.exec(d) ?? /^(aws_ebs_encryption_by_default\.[A-Za-z_][\w-]*)$/.exec(d);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Same provider configuration and Region, compared as written. */
function sameTarget(a: TerraformBlock, b: TerraformBlock): boolean {
  return a.body.provider === b.body.provider && a.body.region === b.body.region;
}

export const tf036: PostSynthCheck = {
  id: "TF036",
  description: "EBS volume does not ask for encryption",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    const defaults = resourcesOfType(ctx, DEFAULT_TYPE);

    for (const block of resourcesOfType(ctx, "aws_ebs_volume")) {
      const encrypted = readBool(block.body, "encrypted");
      if (encrypted.kind === "known" && encrypted.value) continue;
      if (encrypted.kind === "known") {
        out.push(
          finding(
            ID,
            "warning",
            block,
            "sets `encrypted = false`. With the Region's EBS encryption by default off, the volume is unencrypted; " +
              "with it on, AWS encrypts the volume anyway and, because `encrypted` forces replacement, Terraform " +
              "plans to replace it on every apply. Set `encrypted = true` (and `kms_key_id` for a customer managed " +
              "key), or remove the line.",
          ),
        );
        continue;
      }
      if (encrypted.kind === "unknown") {
        out.push(
          notDetermined(ID, block, encrypted.reason, "TF036 does not evaluate expressions, so it cannot tell whether this volume is encrypted."),
        );
        continue;
      }

      const scope = scopeOfKey(block.key);
      const inScope = defaults.filter((d) => scopeOfKey(d.key) === scope && sameTarget(d, block));
      const enabled = inScope.filter((d) => {
        const e = readBool(d.body, "enabled");
        return e.kind === "absent" || (e.kind === "known" && e.value);
      });
      const named = new Set(dependsOnDefaults(block));
      if (enabled.some((d) => named.has(d.address))) continue;

      const parts = ["does not set `encrypted`"];
      if (isGiven(block.body, "snapshot_id")) parts.push("and is built from `snapshot_id`, whose encryption it inherits");
      const reason =
        `${parts.join(" ")}, so whether it is encrypted depends on the Region's EBS encryption by default, which is ` +
        "account state" +
        (enabled.length > 0
          ? `. \`${enabled[0].address}\` turns the default on in this module, but the volume does not \`depends_on\` it, so it may be created first`
          : "");
      out.push(
        notDetermined(
          ID,
          block,
          reason,
          "Set `encrypted = true` to make the answer explicit, or add `depends_on` naming an enabled " +
            "`aws_ebs_encryption_by_default`.",
        ),
      );
    }
    return out;
  },
};
