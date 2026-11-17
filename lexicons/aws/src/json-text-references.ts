/**
 * References that sit inside JSON text (#5285). Cloud Control, and the SQS
 * attribute map floci returns, hold a queue's `RedrivePolicy` as a string of
 * JSON, and IAM returns a policy document as JSON text as well (URL-encoded
 * when it comes from the IAM API). The identity pass reads string leaves, so
 * an ARN inside such a string never equals a node's identity. Each rule here
 * parses the text, reads the ARNs at one named property path and looks them
 * up with the pass's own `find`, so the join is scoped, typed by the holder's
 * kind and refused when ambiguous like every other rule.
 *
 * Paths read:
 * - `AWS::SQS::Queue`: `RedrivePolicy.deadLetterTargetArn` and
 *   `Attributes.RedrivePolicy.deadLetterTargetArn`, the dead-letter queue;
 * - policy documents ({@link POLICY_DOCUMENTS}): `Statement[].Resource` and
 *   `Statement[].Principal.AWS` under each document's path.
 *
 * A value that is not an ARN of a listed node (a wildcard, a service
 * principal, an ARN of a type the lister gives no ARN) names nothing, and the
 * rules are optional, so it is not reported dangling.
 */
import type { IRNode } from "@intentius/chant/graph-ir";
import type { RefRule } from "@intentius/chant/graph-refs";

/** The values at `path` (`a.b`, `arr[].c`) of `obj`, objects and strings kept as they are. */
function rawAt(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const step of path.split(".")) {
    const isArray = step.endsWith("[]");
    const key = isArray ? step.slice(0, -2) : step;
    const next: unknown[] = [];
    for (const c of cur) {
      if (!c || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (isArray) {
        if (Array.isArray(v)) next.push(...v);
      } else {
        next.push(v);
      }
    }
    cur = next;
  }
  return cur;
}

/** JSON text as a value: an object passes through, a string is parsed, and one that is URL-encoded is decoded first. */
export function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  for (const text of [v, safeDecode(v)]) {
    if (text === undefined) continue;
    try {
      return JSON.parse(text);
    } catch {
      /* try the next spelling */
    }
  }
  return undefined;
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The ARN-shaped strings of a list of values; wildcards and plain names are left to match nothing. */
const arns = (vs: string[]): string[] => [...new Set(vs.filter((s) => s.startsWith("arn:")))];

const redrivePaths = ["RedrivePolicy", "Attributes.RedrivePolicy"] as const;

function redriveRule(base: string): RefRule {
  return {
    from: "AWS::SQS::Queue",
    path: `${base}.deadLetterTargetArn`,
    targetKind: "AWS::SQS::Queue",
    relation: "reference",
    label: "dead-letter queue",
    viaAttr: "RedrivePolicy",
    optional: true,
    join(holder: IRNode, find) {
      const out = [];
      for (const doc of rawAt(holder.attrs, base)) {
        for (const arn of arns(strings((parseJsonText(doc) as Record<string, unknown> | undefined)?.deadLetterTargetArn))) {
          out.push({ value: arn, targets: find(arn).filter((n) => n.kind === "AWS::SQS::Queue") });
        }
      }
      return out;
    },
  };
}

/** Where each kind keeps a policy document, as a path from its attrs. */
export const POLICY_DOCUMENTS: ReadonlyArray<{ from: string; path: string }> = [
  { from: "AWS::IAM::Role", path: "AssumeRolePolicyDocument" },
  { from: "AWS::IAM::Role", path: "Policies[].PolicyDocument" },
  { from: "AWS::IAM::ManagedPolicy", path: "PolicyDocument" },
  { from: "AWS::IAM::Policy", path: "PolicyDocument" },
  { from: "AWS::SQS::QueuePolicy", path: "PolicyDocument" },
  { from: "AWS::S3::BucketPolicy", path: "PolicyDocument" },
  { from: "AWS::SQS::Queue", path: "Policy" },
  { from: "AWS::SQS::Queue", path: "Attributes.Policy" },
];

const POLICY_VALUES = [
  { path: "Statement[].Resource", label: "grants on" },
  { path: "Statement[].Principal.AWS", label: "trusts" },
] as const;

function policyRules(): RefRule[] {
  return POLICY_DOCUMENTS.flatMap(({ from, path: docPath }) =>
    POLICY_VALUES.map(({ path: valuePath, label }): RefRule => ({
      from,
      path: `${docPath}.${valuePath}`,
      relation: "reference",
      label,
      optional: true,
      join(holder: IRNode, find) {
        const out = [];
        for (const doc of rawAt(holder.attrs, docPath)) {
          // A statement may be one object where the document would have a list.
          const parsed = parseJsonText(doc);
          const statements = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).Statement : undefined;
          const list = Array.isArray(statements) ? statements : statements ? [statements] : [];
          for (const arn of arns(list.flatMap((s) => rawAt(s, valuePath.replace(/^Statement\[\]\./, "")).flatMap(strings)))) {
            out.push({ value: arn, targets: find(arn) });
          }
        }
        return out;
      },
    })),
  );
}

/** The catalog's rules that read JSON text. */
export function jsonTextRules(): RefRule[] {
  return [...redrivePaths.map(redriveRule), ...policyRules()];
}
