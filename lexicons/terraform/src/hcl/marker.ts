/**
 * choudoufu's live resource markers, as chant reads them (#2104).
 *
 * On a live root the ownership record is not a state file and not a chant
 * stamp: it is two AWS tags on the resource itself, `tofu-estate` and
 * `tofu-address`, specified in `live/MARKERS.md` in
 * https://github.com/INTENTIUS/choudoufu. That file calls itself the one
 * integration surface external tools may rely on, so this module implements
 * exactly what it specifies and nothing beyond it. The spec's own tables are
 * this module's tests (`./marker.test.ts`).
 *
 * ## Escape, then compare. Never decode a tag blind
 *
 * A canonical terraform address uses `[`, `]` and `"` to write an instance
 * key, and AWS allows none of the three in a tag value. So an address is
 * escaped before it is written, and the spec's comparison rule is one
 * sentence: escape the address you already know and compare strings. The
 * reverse, decoding a tag and hoping to recover the address, is ambiguous
 * (`this[2]` and `this["2"]` escape alike) and the spec says not to do it
 * where a verdict depends on the answer.
 *
 * The rule itself, from "Escaping rule":
 *
 *   1. escape the content of every instance key first (see
 *      {@link escapeForEachKey}); a `count` index is only ever digits, so
 *      this is a no-op for one;
 *   2. replace every `[` with `:`;
 *   3. delete every `]`;
 *   4. delete every `"`.
 *
 * Step 1 first is what makes a `:` in an escaped value always mean "an index
 * starts here": a key's own `.` and `:` are already gone by the time steps
 * 2 to 4 run.
 *
 * ## Three escapings on the declared side
 *
 * The key escaping gained a layer twice, and neither change rewrote the
 * markers already on live resources. A marker stamped before choudoufu's
 * issue #178 escaped no key at all; one stamped between #178 and #210
 * doubled `@`, `.` and `:` but did not carry out-of-charset characters into
 * the AWS-legal set. So {@link addressMatches} escapes the declared address
 * three ways and accepts any of them, which is what `AddressMatches` does in
 * choudoufu itself. Writing always uses {@link escapeAddress}, the current
 * form.
 */

/** `tofu-estate`: the estate that owns the resource. The entire ownership claim. */
export const MARKER_TAG_ESTATE = "tofu-estate";

/** `tofu-address`: the resource's escaped canonical address, or its first 256-character chunk. */
export const MARKER_TAG_ADDRESS = "tofu-address";

/** `tofu-slot`: the stable, opaque cardinality slot a `count` instance carries. */
export const MARKER_TAG_SLOT = "tofu-slot";

/**
 * `tofu-address-2` through `tofu-address-4`, in order. A reader concatenates
 * `tofu-address` and whichever of these are present; they are never
 * meaningful on their own.
 */
export const MARKER_TAG_ADDRESS_CONTINUATIONS = [
  "tofu-address-2",
  "tofu-address-3",
  "tofu-address-4",
] as const;

/** The characters AWS allows in a tag value beside letters, digits and space. */
const AWS_LEGAL_PUNCTUATION = new Set(["+", "-", "=", ".", "_", ":", "/", "@"]);

/** The escape introducer of the out-of-charset layer (choudoufu issue #210). */
const INTRODUCER = "+";

function isAwsLegal(ch: string): boolean {
  return /^[A-Za-z0-9 ]$/.test(ch) || AWS_LEGAL_PUNCTUATION.has(ch);
}

/**
 * Carry every character outside the AWS-legal set into it: `+` doubles
 * because it is the introducer, and anything else becomes `+` followed by its
 * Unicode code point in six uppercase hex digits. `a(b)` becomes
 * `a+000028b+000029`; `plus+one` becomes `plus++one`.
 */
function escapeOutOfCharset(key: string): string {
  let out = "";
  for (const ch of key) {
    if (ch === INTRODUCER) out += "++";
    else if (isAwsLegal(ch)) out += ch;
    else out += INTRODUCER + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(6, "0");
  }
  return out;
}

/**
 * The `@` / `.` / `:` doubling (choudoufu issue #178), applied in that order
 * so every `@` these steps introduce is never itself doubled again: `@`
 * becomes `@@`, then `.` becomes `@d`, then `:` becomes `@c`.
 */
function escapeReservedPunctuation(key: string): string {
  let out = "";
  for (const ch of key) {
    if (ch === "@") out += "@@";
    else if (ch === ".") out += "@d";
    else if (ch === ":") out += "@c";
    else out += ch;
  }
  return out;
}

/**
 * Escape one `for_each` instance key, both layers in the specified order:
 * out-of-charset escaping first, then the `@` / `.` / `:` doubling over its
 * output. Order is load-bearing: the first layer's introducer is `+`, none of
 * the three characters the second layer scans for, so the second never
 * mistakes the first's output for its own escape sequences.
 *
 * Six characters cannot be carried at all and are refused at choudoufu's own
 * lint rather than here (`"`, `\`, any non-printable, `$`, `%`, `[`, `]`);
 * this function escapes what it is given without judging it, because chant
 * never writes a marker, and a key chant meets in a `tofu-address` tag has
 * already passed that lint.
 */
export function escapeForEachKey(key: string): string {
  return escapeReservedPunctuation(escapeOutOfCharset(key));
}

/** The pre-#210 key escaping: the doubling alone, with no out-of-charset layer. */
function escapeForEachKeyPre210(key: string): string {
  return escapeReservedPunctuation(key);
}

/**
 * Apply `escapeKey` to the content of every quoted instance key in `address`,
 * then run the address-level substitution: `[` to `:`, `]` and `"` deleted.
 */
function escapeAddressWith(address: string, escapeKey: (key: string) => string): string {
  // Only a quoted key carries content that needs escaping; a `count` index is
  // digits, which every layer leaves alone.
  const keysEscaped = address.replace(/\["((?:[^"\\]|\\.)*)"\]/g, (_all, key: string) => `["${escapeKey(key)}"]`);
  return keysEscaped.replace(/\[/g, ":").replace(/\]/g, "").replace(/"/g, "");
}

/**
 * The `tofu-address` value for a canonical terraform address: the current
 * escaping, which is the only one anything ever writes.
 */
export function escapeAddress(address: string): string {
  return escapeAddressWith(address, escapeForEachKey);
}

/**
 * Every escaping a live marker could have been written under, current first:
 * the current one, the pre-#210 one (the doubling alone), and the pre-#178
 * one (no key escaping at all). Duplicates are collapsed, so the common
 * address with no `for_each` key yields exactly one string.
 */
export function escapeAddressVariants(address: string): string[] {
  const variants = [
    escapeAddress(address),
    escapeAddressWith(address, escapeForEachKeyPre210),
    escapeAddressWith(address, (key) => key),
  ];
  return [...new Set(variants)];
}

/**
 * Does a live resource's `tofu-address` value name this declared address?
 * The declared side is escaped and the strings are compared, three escapings
 * deep for the migration windows; the tag is never decoded.
 */
export function addressMatches(declaredAddress: string, tagValue: string): boolean {
  return escapeAddressVariants(declaredAddress).includes(tagValue);
}

/** What {@link readMarker} found on one live resource's tags. */
export type MarkerVerdict =
  /** Carries `tofu-estate` and a readable `tofu-address`: it belongs to that estate. */
  | { kind: "owned"; estate: string; address: string; slot?: string }
  /** Carries neither key: outside every estate's ownership, reported and never auto-deleted. */
  | { kind: "foreign" }
  /**
   * Carries `tofu-estate` but no readable `tofu-address`: missing, empty, or
   * a continuation chain with a gap in it. A named error, never guessed at
   * and never read as either "belongs to no one" or "close enough".
   */
  | { kind: "malformed"; estate: string; detail: string };

/**
 * Concatenate `tofu-address` and whatever continuation tags follow it, which
 * is the only sanctioned way to read a split address.
 *
 * A chain with a gap in it (`tofu-address-3` present while `tofu-address-2`
 * is not) cannot be concatenated into anything and returns `undefined` rather
 * than the address up to the gap.
 */
export function joinMarkerAddress(tags: Record<string, string | undefined>): string | undefined {
  const head = tags[MARKER_TAG_ADDRESS];
  if (head === undefined || head === "") return undefined;

  let address = head;
  let ended = false;
  for (const key of MARKER_TAG_ADDRESS_CONTINUATIONS) {
    const chunk = tags[key];
    if (chunk === undefined || chunk === "") {
      ended = true;
      continue;
    }
    if (ended) return undefined; // a gap: the chain is malformed, not shorter
    address += chunk;
  }
  return address;
}

/**
 * The ownership verdict `live/MARKERS.md`'s "Ownership semantics" section
 * defines, read off one live resource's tags. Three outcomes, and no fourth:
 * a `tofu-estate` value is the entire ownership claim with no secondary
 * check, neither key present is foreign, and an estate without a readable
 * address is malformed rather than either of the two.
 */
export function readMarker(tags: Record<string, string | undefined> | undefined): MarkerVerdict {
  const estate = tags?.[MARKER_TAG_ESTATE];
  if (estate === undefined || estate === "") return { kind: "foreign" };

  const address = joinMarkerAddress(tags!);
  if (address === undefined) {
    return {
      kind: "malformed",
      estate,
      detail: `carries ${MARKER_TAG_ESTATE}=${estate} but no readable ${MARKER_TAG_ADDRESS} (missing, empty, or a continuation chain with a gap in it)`,
    };
  }

  const slot = tags![MARKER_TAG_SLOT];
  return { kind: "owned", estate, address, ...(slot ? { slot } : {}) };
}
