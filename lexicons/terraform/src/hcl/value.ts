/**
 * A value envelope over a parsed block body (chant #2113).
 *
 * Every TF post-synth check reads `BlockBody` (`./parse.ts`), raw
 * `@cdktf/hcl2json` output, and re-derives, by hand, whether an attribute is
 * a plain literal, a reference/expression, or absent. tflint's OPA ruleset
 * hands a policy `{value, unknown, sensitive, ephemeral, range}` per
 * attribute so a check reads that uniformly instead of re-deriving it
 * (`tflint-ruleset-opa`'s `docs/functions.md`, cited in the #2107 survey).
 * `attr()` is the equivalent for chant's static string-based body.
 *
 * The shape here is narrower than tflint's for one structural reason.
 * hcl2json converts HCL to plain JSON with no evaluation and no position
 * data. There is no live Terraform graph behind this parse, so there is no
 * `unknown` (this runs over source, not a plan), and no `sensitive`/
 * `ephemeral` flag (those live on a `variable` block's own attributes, not on
 * every attribute that happens to reference one; a check that cares reads
 * the referenced variable's declaration itself). `range` is the one field
 * tflint's envelope carries that this cannot. hcl2json's own output is bare
 * values, JSON-round-tripped from HCL, with no line/column/byte-range
 * attached anywhere in the tree, so there is nothing for `attr()` to read a
 * position from. (#2111 adds a `props.line` to the *entity*, from a separate
 * text-based mechanism this file does not touch and is not a substitute for
 * per-attribute ranges. See that issue for how it gets a line at all.)
 */

import type { BlockBody } from "./parse";

/** What kind of value an attribute holds, once template interpolation is accounted for. */
export type AttrKind = "literal" | "reference" | "template" | "absent";

/**
 * The value envelope `attr()` returns for one attribute of a block body.
 *
 * `raw` is always the untouched `body[name]` (or `undefined` when absent),
 * so a caller that needs the original hcl2json value for a case this
 * envelope doesn't model can still reach it without a second lookup.
 */
export interface AttrValue {
  kind: AttrKind;
  /**
   * The attribute's value when `kind` is `"literal"`: a string, number,
   * boolean, array or object, verbatim from hcl2json. Absent for every other
   * kind (a reference/template's "value" is not known statically).
   */
  value?: unknown;
  /**
   * The expression(s) found inside `${...}` for `"reference"` and
   * `"template"`: one entry for `"reference"` (the whole interpolation),
   * one per `${...}` span in source order for `"template"`. Absent for
   * `"literal"`/`"absent"`.
   */
  refs?: string[];
  /** The untouched `body[name]`, regardless of `kind`. `undefined` when absent. */
  raw: unknown;
}

/**
 * Every `${...}` span within a string, in source order. One level of nested
 * `{...}` is tolerated (an object constructor or a map-typed function argument
 * inside the interpolation), which is as far as a regex can go without
 * becoming a brace-counting parser. `attr()` below decides `"reference"` vs
 * `"template"` from how many spans this finds and whether the one span (if
 * there is exactly one) consumes the whole string, not from a second,
 * separately-anchored pattern, so the two checks can't disagree about what
 * counts as an interpolation.
 */
const INTERPOLATION_SPANS = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;

/**
 * Read one attribute of a parsed block body as a value envelope.
 *
 * - `"absent"`: `name` is not a key of `body` at all (or is `undefined`/`null`).
 * - `"reference"`: the value is a string that is nothing but one
 *   `${...}` interpolation (`"${aws_s3_bucket.foo.id}"`, `"${var.x}"`,
 *   `"${lower(var.x)}"`; a function call counts, since the whole value is
 *   still one expression, not a literal). `refs` carries that one expression.
 * - `"template"`: the value is a string with `${...}` interpolation mixed
 *   with literal text (`"prefix-${var.x}-suffix"`, or two interpolations in
 *   one string). `refs` carries every span found, in source order.
 * - `"literal"`: anything else. A plain string with no interpolation, a
 *   number, a boolean, an array, or an object (which is how hcl2json encodes
 *   a nested block under the same key a caller might ask `attr()` about, so
 *   a nested block reads as `kind: "literal"` with `value` holding its body
 *   or bodies array). See `hasBlock()` in `../lint/post-synth/tf001.ts`,
 *   which is exactly that case.
 *
 * A malformed `${` with no matching `}` is not specially detected; it falls
 * through to `"literal"` (no complete span found), matching hcl2json's own
 * behavior of passing such text through as a plain string.
 */
export function attr(body: BlockBody, name: string): AttrValue {
  const raw = body[name];
  if (raw === undefined || raw === null) return { kind: "absent", raw };

  if (typeof raw === "string") {
    const spans = [...raw.matchAll(INTERPOLATION_SPANS)];
    if (spans.length === 0) return { kind: "literal", value: raw, raw };

    const refs = spans.map((m) => m[1].trim());
    const isWholeString = spans.length === 1 && spans[0].index === 0 && spans[0][0].length === raw.length;
    return isWholeString ? { kind: "reference", refs, raw } : { kind: "template", refs, raw };
  }

  return { kind: "literal", value: raw, raw };
}
