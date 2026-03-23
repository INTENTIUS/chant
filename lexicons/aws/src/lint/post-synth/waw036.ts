/**
 * WAW036: Non-ASCII Characters in EC2/IAM String Properties
 *
 * EC2, IAM, CloudWatch, and other AWS services only accept ASCII 0x20–0x7E in
 * description, name, and label fields. Non-ASCII characters (em-dashes, curly
 * quotes, accented letters, etc.) cause the changeset to fail at EarlyValidation
 * with an opaque "Invalid parameter" error that doesn't name the offending property.
 *
 * Properties checked (all must be plain ASCII strings):
 *   - AWS::EC2::SecurityGroup           GroupDescription
 *   - AWS::EC2::LaunchTemplate          LaunchTemplateName
 *   - AWS::IAM::Role                    RoleName
 *   - AWS::Lambda::Function             FunctionName
 *   - AWS::RDS::DBSubnetGroup           DBSubnetGroupDescription
 *   - AWS::CloudWatch::Alarm            AlarmDescription, AlarmName
 *   - AWS::AutoScaling::AutoScalingGroup AutoScalingGroupName
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

/** Map of CFN resource type → list of property names that must be ASCII-only. */
const ASCII_REQUIRED: Record<string, string[]> = {
  "AWS::EC2::SecurityGroup":             ["GroupDescription"],
  "AWS::EC2::LaunchTemplate":            ["LaunchTemplateName"],
  "AWS::IAM::Role":                      ["RoleName"],
  "AWS::Lambda::Function":               ["FunctionName"],
  "AWS::RDS::DBSubnetGroup":             ["DBSubnetGroupDescription"],
  "AWS::CloudWatch::Alarm":              ["AlarmDescription", "AlarmName"],
  "AWS::AutoScaling::AutoScalingGroup":  ["AutoScalingGroupName"],
};

/** Return true if the string contains any character outside ASCII printable range (0x20–0x7E). */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return true;
  }
  return false;
}

export function checkNonAsciiProps(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const propsToCheck = ASCII_REQUIRED[resource.Type];
      if (!propsToCheck) continue;

      const props = resource.Properties ?? {};

      for (const propName of propsToCheck) {
        const value = props[propName];
        if (typeof value !== "string") continue;
        if (!hasNonAscii(value)) continue;

        // Find the specific offending characters for the message.
        const badChars = [...new Set([...value].filter((c) => {
          const code = c.charCodeAt(0);
          return code < 0x20 || code > 0x7e;
        }))];
        const charList = badChars.map((c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(", ");

        diagnostics.push({
          checkId: "WAW036",
          severity: "error",
          message: `${resource.Type} "${logicalId}" property "${propName}" contains non-ASCII characters (${charList}) — AWS rejects these at changeset validation time`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw036: PostSynthCheck = {
  id: "WAW036",
  description: "Non-ASCII characters in EC2/IAM/CW string properties — rejected at changeset time",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkNonAsciiProps(ctx);
  },
};
