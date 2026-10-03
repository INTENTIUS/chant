/**
 * Shared reading helpers for TF033-TF037, the five flat encryption and
 * immutability rules (chant #2288, epic #2284).
 *
 * Each of those rules reads one or two scalar attributes of one resource type
 * and answers a three-valued question: the literal proves the resource
 * secure, the literal proves it insecure, or the parse cannot tell. This
 * module is the reading half; each rule file holds its own answer for
 * absence, because that answer differs per resource (see each rule's doc
 * comment and its section of `docs/pages/lint-rules.mdx`). It exports no
 * `PostSynthCheck`, so the generated barrel skips it.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { RESOURCE_TYPE, type BlockBody } from "../../hcl/parse";
import { attr } from "../../hcl/value";
import { blocksOfType, nestedBodies, type TerraformBlock } from "./blocks";

/** What one attribute read settles. `reason` says why a value could not be read. */
export type Read<T> = { kind: "known"; value: T } | { kind: "absent" } | { kind: "unknown"; reason: string };

/** Every `resource` block of one provider type (`aws_sqs_queue`), in entity order. */
export function resourcesOfType(ctx: PostSynthContext, type: string): TerraformBlock[] {
  return blocksOfType(ctx, RESOURCE_TYPE).filter((b) => b.address.startsWith(`${type}.`));
}

/** One expression, for a message: `var.encrypted`, or the template text. */
function describe(name: string, raw: unknown, refs: string[] | undefined, kind: "reference" | "template"): string {
  return kind === "reference"
    ? `\`${name}\` is an expression (${refs?.[0] ?? String(raw)})`
    : `\`${name}\` is a template string ("${String(raw)}")`;
}

/**
 * A bool attribute. Terraform converts the strings `"true"` and `"false"` to
 * bool, so those read as the bool they convert to. Any other literal (a
 * number, a list) is a plan-time type error, not this rule's concern, and
 * reads as unknown.
 */
export function readBool(body: BlockBody, name: string): Read<boolean> {
  const a = attr(body, name);
  if (a.kind === "absent") return { kind: "absent" };
  if (a.kind === "reference" || a.kind === "template") {
    return { kind: "unknown", reason: describe(name, a.raw, a.refs, a.kind) };
  }
  if (typeof a.value === "boolean") return { kind: "known", value: a.value };
  if (a.value === "true" || a.value === "false") return { kind: "known", value: a.value === "true" };
  return { kind: "unknown", reason: `\`${name}\` is not a bool (${JSON.stringify(a.value)})` };
}

/** A string attribute, literal or not. */
export function readString(body: BlockBody, name: string): Read<string> {
  const a = attr(body, name);
  if (a.kind === "absent") return { kind: "absent" };
  if (a.kind === "reference" || a.kind === "template") {
    return { kind: "unknown", reason: describe(name, a.raw, a.refs, a.kind) };
  }
  if (typeof a.value === "string") return { kind: "known", value: a.value };
  return { kind: "unknown", reason: `\`${name}\` is not a string (${JSON.stringify(a.value)})` };
}

/** Expression roots that name an input or a computed value, not a managed object. */
const VALUE_ROOTS = new Set(["var", "local", "module", "each", "count", "path", "terraform", "self"]);

/** `aws_kms_key.sns.arn`, `data.aws_kms_alias.sqs.target_key_arn`, with an optional index or splat. */
const OBJECT_ATTRIBUTE = /^(?:data\.)?([a-z][a-z0-9_]*)\.[A-Za-z_][\w-]*(?:\[[^\]]*\])?(?:\.[A-Za-z_][\w-]*|\[[^\]]*\])+$/;

/** Every `${...}` span in a template, as `attr()` finds them. */
const SPANS = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;

/**
 * Whether a key-like argument (`kms_master_key_id`) is set to something.
 *
 * - absent, or `null`: `absent`.
 * - a literal: `known`, with the string (`""` is a value, and a rule decides
 *   what an empty key means).
 * - an attribute of a managed resource or data source (`aws_kms_key.x.arn`):
 *   `known` and non-empty. The provider computes a key's id or ARN; it is
 *   never the empty string, so the key is set whatever its value turns out to
 *   be.
 * - a template with literal text (`"alias/${var.env}-sns"`): `known` and
 *   non-empty, for the same reason.
 * - anything else (`var.kms_key`, `local.key`, a conditional, a function
 *   call): `unknown`. A variable can be `null` or `""`.
 */
export function readKeySet(body: BlockBody, name: string): Read<string> {
  const a = attr(body, name);
  if (a.kind === "absent") return { kind: "absent" };
  if (a.kind === "literal") {
    return typeof a.value === "string"
      ? { kind: "known", value: a.value }
      : { kind: "unknown", reason: `\`${name}\` is not a string (${JSON.stringify(a.value)})` };
  }
  const raw = String(a.raw);
  if (a.kind === "template") {
    if (raw.replace(SPANS, "").length > 0) return { kind: "known", value: raw };
    return { kind: "unknown", reason: describe(name, a.raw, a.refs, "template") };
  }
  const expr = (a.refs?.[0] ?? "").trim();
  const m = OBJECT_ATTRIBUTE.exec(expr);
  if (m && !VALUE_ROOTS.has(m[1])) return { kind: "known", value: raw };
  return { kind: "unknown", reason: describe(name, a.raw, a.refs, "reference") };
}

/**
 * Whether an argument that names a source (`snapshot_identifier`,
 * `replicate_source_db`) or a nested block (`restore_to_point_in_time`) is
 * given. The provider reads these with `GetOk`, so a literal `""` is the same
 * as leaving the argument out; anything else, a reference included, is given.
 */
export function isGiven(body: BlockBody, name: string): boolean {
  const a = attr(body, name);
  if (a.kind === "absent") return false;
  if (a.kind === "literal") {
    if (a.value === "" || a.value === false) return false;
    if (Array.isArray(a.value)) return a.value.length > 0;
  }
  return true;
}

/** The bodies of a nested block, re-exported for the rule files. */
export { nestedBodies };

/** A finding the literal proves. */
export function finding(
  checkId: string,
  severity: "error" | "warning",
  block: TerraformBlock,
  message: string,
): PostSynthDiagnostic {
  return { checkId, severity, message: `"${block.address}" ${message}`, entity: block.key, lexicon: "terraform" };
}

/**
 * The one `info` diagnostic a rule emits when it cannot read the value it
 * needs. The message starts `Not determined:`, as #2284 fixed for TF030-TF037.
 */
export function notDetermined(checkId: string, block: TerraformBlock, reason: string, tail: string): PostSynthDiagnostic {
  return {
    checkId,
    severity: "info",
    message: `Not determined: "${block.address}" ${reason}. ${tail}`,
    entity: block.key,
    lexicon: "terraform",
  };
}
