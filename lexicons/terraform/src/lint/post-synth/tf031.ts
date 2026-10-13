/**
 * TF031: an IAM policy allows a wildcard Action or a wildcard Resource
 * (chant #2286, epic #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW020, written natively
 * against the parsed HCL rather than bridged (docs/design/waw-hcl-fidelity-probe.md
 * explains why a bridge reported nothing here). WAW020 flags `Action: "*"`
 * only; this rule also flags `Resource: "*"`, as #2286 asks and as tfsec's
 * `aws-iam-no-policy-wildcards` does.
 *
 * What it reads. A policy argument in Terraform is a string, and hcl2json
 * hands it over unevaluated, so the rule reads three shapes and no others:
 *
 * - `jsonencode({...})`: hcl2json keeps the call as the one string
 *   `"${jsonencode({...})}"` with HCL object syntax inside. `readJsonencode`
 *   (`../../hcl/jsonencode.ts`) reads the literal parts of that argument as
 *   structure, leaving each expression in it as an opaque leaf.
 * - a literal string, which is what a heredoc with no interpolation becomes in
 *   the parse: the JSON text itself, read with `JSON.parse`.
 * - a `data "aws_iam_policy_document"` block, whose `statement { actions,
 *   resources, effect }` arrive as plain structure. A policy argument that is
 *   exactly `data.aws_iam_policy_document.<name>.json` (or `.minified_json`)
 *   naming a document declared in the same module is not reported again: the
 *   document is checked where it is declared.
 *
 * The three-valued answer. A finding needs a literal that proves it: an
 * `Allow` statement (the data source's default effect, or a literal
 * `"Allow"`) whose Action or Resource is the literal `"*"` or a list holding
 * it. A `Deny` statement never fires; `Deny` with `Action = "*"` is the usual
 * guard rail. When the value the rule needs is not readable (a reference, a
 * `file()` or `templatefile()` call, a template, a for-expression, a
 * `dynamic "statement"`), the rule emits one `info` diagnostic starting
 * `Not determined:` that names the attribute and why, and never a warning.
 * A value that cannot be `"*"` whatever it evaluates to is not "not
 * determined": an attribute of a managed resource or data source
 * (`aws_s3_bucket.logs.arn`) or a template whose literal text already
 * differs from `*` (`"arn:aws:s3:::${var.bucket}/*"`) is read as scoped.
 *
 * Absence. A resource with no policy argument, or a role with no
 * `inline_policy`, is unconfigured, not insecure, and is not reported.
 *
 * In scope: `aws_iam_policy.policy`, `aws_iam_role_policy.policy`,
 * `aws_iam_user_policy.policy`, `aws_iam_group_policy.policy`,
 * `aws_iam_role.inline_policy[].policy`, `aws_iam_role.assume_role_policy`
 * (WAW020 walks `AssumeRolePolicyDocument` too) and the
 * `aws_iam_policy_document` data source. Resource-based policies (S3, SQS,
 * KMS, VPC endpoint) are out of scope: there `Resource: "*"` usually means
 * "this resource" and the risk sits in `Principal`.
 *
 * Scope: root and child modules alike (#2112). The condition is a property
 * of the block itself.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { DATA_TYPE, RESOURCE_TYPE, scopeOfKey, type BlockBody } from "../../hcl/parse";
import { attr } from "../../hcl/value";
import { hasUnknownKeys, isUnknown, readJsonencode } from "../../hcl/jsonencode";
import { blocksOfType, nestedBodies, type TerraformBlock } from "./blocks";

/** Resource type to the string-valued policy arguments it carries. */
const POLICY_ARGUMENTS: Record<string, readonly string[]> = {
  aws_iam_policy: ["policy"],
  aws_iam_role_policy: ["policy"],
  aws_iam_user_policy: ["policy"],
  aws_iam_group_policy: ["policy"],
  aws_iam_role: ["assume_role_policy"],
};

const POLICY_DOCUMENT = "aws_iam_policy_document";

/** One readable value's answer to "is this `*`?". */
type Star = { kind: "star" } | { kind: "no" } | { kind: "unknown"; reason: string };

const NO: Star = { kind: "no" };
const STAR: Star = { kind: "star" };

/** A statement that proves a wildcard. */
interface Hit {
  /** 1-based statement position within its document. */
  index: number;
  sid?: string;
  fields: string[];
}

/** What reading one document found. */
interface DocumentRead {
  hits: Hit[];
  unknown: string[];
}

/** Expression roots that name an input or a computed value, not a managed object. */
const VALUE_ROOTS = new Set(["var", "local", "module", "each", "count", "path", "terraform", "self"]);

/** `aws_s3_bucket.logs.arn`, `data.aws_caller_identity.current.account_id`, with optional index or splat. */
const OBJECT_ATTRIBUTE = /^(?:data\.)?([a-z][a-z0-9_]*)\.[A-Za-z_][\w-]*(?:\[[^\]]*\])?(?:\.[A-Za-z_][\w-]*|\[[^\]]*\])+$/;

const SPANS = /[$%]\{(?:[^{}]|\{[^{}]*\})*\}/g;

/**
 * Whether an expression the rule cannot evaluate could still be `*`. A
 * resource or data source attribute is a provider-computed ARN or id, never
 * `*`; a template is `*` only if its literal text is nothing but `*`.
 */
function couldBeStar(expr: string): boolean {
  const e = expr.trim();
  if (e.startsWith('"') && e.endsWith('"') && e.length >= 2) return templateCouldBeStar(e.slice(1, -1));
  const m = OBJECT_ATTRIBUTE.exec(e);
  if (m && !VALUE_ROOTS.has(m[1])) return false;
  return true;
}

function templateCouldBeStar(text: string): boolean {
  return /^\**$/.test(text.replace(SPANS, ""));
}

/** One string from the hcl2json tree (a data source list element or effect). */
function hclString(value: string, what: string): Star {
  const a = attr({ v: value }, "v");
  if (a.kind === "literal") return value === "*" ? STAR : NO;
  if (a.kind === "reference") {
    const expr = a.refs?.[0] ?? "";
    return couldBeStar(expr) ? { kind: "unknown", reason: `${what} is an expression (${expr})` } : NO;
  }
  return templateCouldBeStar(value) ? { kind: "unknown", reason: `${what} is a template ("${value}")` } : NO;
}

/** Action or Resource in a policy JSON tree (from jsonencode or JSON.parse). */
function jsonStar(value: unknown, field: string): Star {
  if (value === "*") return STAR;
  if (isUnknown(value)) {
    return couldBeStar(value.source) ? { kind: "unknown", reason: `${field} is ${value.reason}` } : NO;
  }
  if (Array.isArray(value)) return anyStar(value.map((v) => jsonStar(v, field)));
  return NO;
}

/** A list holds `*` if any element does; it is unknown if none does and one could. */
function anyStar(items: Star[]): Star {
  if (items.some((s) => s.kind === "star")) return STAR;
  return items.find((s) => s.kind === "unknown") ?? NO;
}

type Effect = "allow" | "other" | { unknown: string };

/** Read one statement's Effect, Action and Resource and add what it proves to `out`. */
function judge(index: number, sid: string | undefined, effect: Effect, action: Star, resource: Star, out: DocumentRead): void {
  if (effect === "other") return;
  const fields: string[] = [];
  if (action.kind === "star") fields.push("Action");
  if (resource.kind === "star") fields.push("Resource");
  if (effect !== "allow") {
    if (fields.length > 0 || action.kind === "unknown" || resource.kind === "unknown") {
      out.unknown.push(`statement ${index} Effect is ${effect.unknown}`);
    }
    return;
  }
  if (fields.length > 0) {
    out.hits.push({ index, sid, fields });
    return;
  }
  for (const s of [action, resource]) if (s.kind === "unknown") out.unknown.push(`statement ${index} ${s.reason}`);
}

/** A policy document's statements, as JSON structure. */
function readJsonDocument(doc: unknown, out: DocumentRead): void {
  if (isUnknown(doc)) {
    out.unknown.push(`the document is ${doc.reason}`);
    return;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  const record = doc as Record<string, unknown>;
  const statement = record.Statement;
  if (statement === undefined) {
    if (hasUnknownKeys(record)) out.unknown.push("the document has a key that is an expression");
    return;
  }
  if (isUnknown(statement)) {
    out.unknown.push(`Statement is ${statement.reason}`);
    return;
  }
  const list = Array.isArray(statement) ? statement : [statement];
  list.forEach((stmt, i) => {
    const index = i + 1;
    if (isUnknown(stmt)) {
      out.unknown.push(`statement ${index} is ${stmt.reason}`);
      return;
    }
    if (typeof stmt !== "object" || stmt === null || Array.isArray(stmt)) return;
    const s = stmt as Record<string, unknown>;
    const missing = s.Effect === undefined || s.Action === undefined || s.Resource === undefined;
    if (hasUnknownKeys(s) && missing) {
      out.unknown.push(`statement ${index} has a key that is an expression`);
    }
    const effect: Effect = isUnknown(s.Effect)
      ? { unknown: s.Effect.reason }
      : s.Effect === "Allow"
        ? "allow"
        : "other";
    const sid = typeof s.Sid === "string" && s.Sid !== "" ? s.Sid : undefined;
    judge(index, sid, effect, jsonStar(s.Action, "Action"), jsonStar(s.Resource, "Resource"), out);
  });
}

/** `actions`/`resources` of a policy-document statement block. */
function hclListStar(body: BlockBody, name: string, field: string): Star {
  const value = body[name];
  if (value === undefined || value === null) return NO;
  if (typeof value === "string") return hclString(value, `\`${name}\``);
  if (Array.isArray(value)) {
    return anyStar(value.map((v) => (typeof v === "string" ? hclString(v, `an element of \`${name}\``) : NO)));
  }
  return { kind: "unknown", reason: `\`${name}\` is not a list of strings (${field})` };
}

/** Read the `statement` blocks of a `data "aws_iam_policy_document"`. */
function readPolicyDocumentBlock(body: BlockBody): DocumentRead {
  const out: DocumentRead = { hits: [], unknown: [] };
  nestedBodies(body, "statement").forEach((stmt, i) => {
    const index = i + 1;
    const e = attr(stmt, "effect");
    // `effect` defaults to "Allow" in the provider schema, so absence allows.
    const effect: Effect =
      e.kind === "absent"
        ? "allow"
        : e.kind === "literal"
          ? e.value === "Allow"
            ? "allow"
            : "other"
          : { unknown: `an expression (${e.refs?.join(", ") ?? ""})` };
    const sid = typeof stmt.sid === "string" && attr(stmt, "sid").kind === "literal" && stmt.sid !== "" ? stmt.sid : undefined;
    judge(index, sid, effect, hclListStar(stmt, "actions", "Action"), hclListStar(stmt, "resources", "Resource"), out);
  });
  for (const dyn of nestedBodies(body, "dynamic")) {
    if (dyn.statement !== undefined && out.hits.length === 0) {
      out.unknown.push('a `dynamic "statement"` block generates statements from an expression');
    }
  }
  return out;
}

/** The `data.aws_iam_policy_document.<name>` a policy argument names, when it is exactly its `.json`. */
const DOCUMENT_JSON = /^data\.aws_iam_policy_document\.([A-Za-z_][\w-]*)\.(?:json|minified_json)$/;

/** Read one string-valued policy argument. `null` when there is nothing to report on (absent, or checked elsewhere). */
function readPolicyArgument(
  body: BlockBody,
  name: string,
  documentDeclared: (docName: string) => boolean,
): DocumentRead | null {
  const a = attr(body, name);
  if (a.kind === "absent") return null;
  const out: DocumentRead = { hits: [], unknown: [] };

  const encoded = readJsonencode(a.raw, { unknownLeaves: true });
  if (encoded.kind === "literal") {
    readJsonDocument(encoded.value, out);
    return out;
  }
  if (encoded.kind === "not-determined") {
    out.unknown.push(`it is a jsonencode() call whose argument holds ${encoded.reason}`);
    return out;
  }

  if (a.kind === "reference") {
    const expr = a.refs?.[0] ?? "";
    const doc = DOCUMENT_JSON.exec(expr);
    if (doc && documentDeclared(doc[1])) return null;
    const call = /^([a-z_]+)\s*\(/.exec(expr);
    out.unknown.push(
      call
        ? `it is a ${call[1]}() call, which TF031 does not evaluate`
        : `it is a reference (${expr}) to a value TF031 cannot read here`,
    );
    return out;
  }
  if (a.kind === "template") {
    out.unknown.push("it is a template string with interpolations");
    return out;
  }
  if (typeof a.value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.value);
  } catch {
    out.unknown.push("it is a literal string that does not parse as JSON (a heredoc with template directives, or not a policy)");
    return out;
  }
  readJsonDocument(parsed, out);
  return out;
}

function describeHits(hits: Hit[]): string {
  return hits
    .map((h) => {
      const label = h.sid ? `statement ${h.index} (Sid "${h.sid}")` : `statement ${h.index}`;
      return `${label} allows ${h.fields.map((f) => `${f} "*"`).join(" and ")}`;
    })
    .join("; ");
}

function report(block: TerraformBlock, where: string, read: DocumentRead, diagnostics: PostSynthDiagnostic[]): void {
  if (read.hits.length > 0) {
    diagnostics.push({
      checkId: "TF031",
      severity: "warning",
      message:
        `"${block.address}" ${where}: ${describeHits(read.hits)}. Action "*" grants every AWS action and ` +
        'Resource "*" reaches every resource in the account, including ones created later. Name the actions ' +
        "the workload calls and the ARNs it touches. A few actions (ecr:GetAuthorizationToken, " +
        'sts:GetCallerIdentity) accept only Resource "*"; keep such a statement with a ' +
        "`# chant-ignore-block: TF031` above the block.",
      entity: block.key,
      lexicon: "terraform",
    });
    return;
  }
  if (read.unknown.length > 0) {
    const more = read.unknown.length > 1 ? ` (and ${read.unknown.length - 1} more)` : "";
    diagnostics.push({
      checkId: "TF031",
      severity: "info",
      message:
        `Not determined: "${block.address}" ${where}: ${read.unknown[0]}${more}. TF031 reads only literal ` +
        "policy structure and does not evaluate expressions, so it cannot tell whether this policy allows " +
        'Action "*" or Resource "*".',
      entity: block.key,
      lexicon: "terraform",
    });
  }
}

export const tf031: PostSynthCheck = {
  id: "TF031",
  description: "IAM policy allows a wildcard Action or Resource",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const documents = blocksOfType(ctx, DATA_TYPE).filter((b) => b.address.startsWith(`data.${POLICY_DOCUMENT}.`));
    const declared = new Set(documents.map((b) => `${scopeOfKey(b.key)}/${b.address}`));

    for (const block of blocksOfType(ctx, RESOURCE_TYPE)) {
      const type = block.address.slice(0, block.address.indexOf("."));
      const names = POLICY_ARGUMENTS[type];
      if (!names) continue;
      const scope = scopeOfKey(block.key);
      const documentDeclared = (name: string): boolean => declared.has(`${scope}/data.${POLICY_DOCUMENT}.${name}`);

      for (const name of names) {
        const read = readPolicyArgument(block.body, name, documentDeclared);
        if (read) report(block, `\`${name}\``, read, diagnostics);
      }
      if (type === "aws_iam_role") {
        nestedBodies(block.body, "inline_policy").forEach((inline, i) => {
          const read = readPolicyArgument(inline, "policy", documentDeclared);
          if (read) report(block, `\`inline_policy[${i}].policy\``, read, diagnostics);
        });
      }
    }

    for (const block of documents) {
      report(block, "`statement`", readPolicyDocumentBlock(block.body), diagnostics);
    }

    return diagnostics;
  },
};
