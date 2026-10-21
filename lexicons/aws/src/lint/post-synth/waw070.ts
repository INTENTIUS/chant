/**
 * WAW070: Ref or Fn::GetAtt names something the template doesn't declare
 *
 * A `Ref` must name a resource, a parameter or an `AWS::` pseudo-parameter,
 * and a `Fn::GetAtt` must name a resource. CloudFormation rejects a template
 * whose reference names neither (cfn-lint E1012/E1010). chant built such a
 * template when a value read another lexicon's resource (#4180); the
 * serializer now turns that into a parameter, and this check catches any
 * reference still left dangling.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

interface DanglingRef {
  target: string;
  via: "Ref" | "Fn::GetAtt";
}

function collectRefs(value: unknown, out: DanglingRef[], seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.Ref === "string" && Object.keys(obj).length === 1) {
    out.push({ target: obj.Ref, via: "Ref" });
    return;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (getAtt !== undefined && Object.keys(obj).length === 1) {
    const target = Array.isArray(getAtt) ? getAtt[0] : typeof getAtt === "string" ? getAtt.split(".")[0] : undefined;
    if (typeof target === "string") out.push({ target, via: "Fn::GetAtt" });
    if (Array.isArray(getAtt)) collectRefs(getAtt.slice(1), out, seen);
    return;
  }
  for (const v of Object.values(obj)) collectRefs(v, out, seen);
}

export function checkDanglingRefs(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [lexicon, output] of ctx.outputs) {
    if (lexicon !== "aws") continue;
    const template = parseCFTemplate(output);
    if (!template?.Resources || typeof template.Resources !== "object") continue;

    const resources = new Set(Object.keys(template.Resources));
    const parameters = new Set(Object.keys((template.Parameters as Record<string, unknown> | undefined) ?? {}));

    const report = (where: string, value: unknown) => {
      const refs: DanglingRef[] = [];
      collectRefs(value, refs);
      for (const ref of refs) {
        const known = ref.via === "Ref"
          ? resources.has(ref.target) || parameters.has(ref.target) || ref.target.startsWith("AWS::")
          : resources.has(ref.target);
        if (known) continue;
        diagnostics.push({
          checkId: "WAW070",
          severity: "error",
          message: `${where} has ${ref.via} "${ref.target}", which is not ${ref.via === "Ref" ? "a resource, a parameter or a pseudo-parameter" : "a resource"} in this template`,
          entity: where.replace(/^(Resource|Output) /, "").replace(/"/g, ""),
          lexicon: "aws",
        });
      }
    };

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      report(`Resource "${logicalId}"`, resource.Properties);
    }
    for (const [name, out] of Object.entries((template.Outputs as Record<string, { Value?: unknown }> | undefined) ?? {})) {
      report(`Output "${name}"`, out?.Value);
    }
  }

  return diagnostics;
}

export const waw070: PostSynthCheck = {
  id: "WAW070",
  description: "Ref or Fn::GetAtt names something the template doesn't declare",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkDanglingRefs(ctx);
  },
};
