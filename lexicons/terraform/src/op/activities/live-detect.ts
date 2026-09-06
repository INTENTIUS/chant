/**
 * A fast, regex-based read of whether a root module directory declares a
 * live estate: an `estate.chdf.hcl` sidecar, or a `live { ... }` block nested
 * inside a `terraform { ... }` block of some `.tf` file (#2103).
 *
 * Deliberately separate from `../../hcl/parse.ts`'s AST-accurate detection
 * (`blocksToEntities`'s `liveBlocksIn`), which the build and lint paths use.
 * `op/activities/terraform.ts` is loaded by a Temporal worker and is
 * dependency-light on purpose, since it shells out to the configured binary and
 * never touches the lexicon's HCL parse or serializer, so it never pulls in
 * the ~1.8 MB `@cdktf/hcl2json` wasm parser just to decide whether an apply
 * should run `apply -auto-approve` with no plan file. Plain text and a
 * hand-rolled brace counter are enough for that narrower question, and the
 * literal sidecar filename below is kept in sync with `LIVE_SIDECAR_FILENAME`
 * in `../../hcl/parse.ts` by hand rather than by importing it, for the same
 * reason.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Kept in sync with `LIVE_SIDECAR_FILENAME` in `../../hcl/parse.ts`. */
const LIVE_SIDECAR_FILENAME = "estate.chdf.hcl";

/**
 * Find `keyword {` and return the matching `{ ... }` body's inner text, via
 * brace counting rather than a regex (HCL bodies nest, and a lone regex
 * cannot match balanced braces).
 */
function extractBalancedBlock(source: string, keyword: string): string | undefined {
  const re = new RegExp(`\\b${keyword}\\s*\\{`);
  const opening = re.exec(source);
  if (!opening) return undefined;

  let depth = 0;
  let start = -1;
  for (let i = opening.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return undefined; // unbalanced, malformed HCL, not this function's problem to diagnose
}

/** Pull a quoted `estate = "..."` attribute's value out of a block's inner text. */
function extractEstateAttr(body: string): string | undefined {
  const match = /estate\s*=\s*"([^"]*)"/.exec(body);
  return match && match[1] !== "" ? match[1] : undefined;
}

/** Pull a quoted `<key> = "..."` attribute's value out of a block's inner text. */
function extractQuotedAttr(body: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(body);
  return match && match[1] !== "" ? match[1] : undefined;
}

/**
 * The declared estate name for the root module directory `dir`, or
 * `undefined` when none is declared. Checks the `estate.chdf.hcl` sidecar
 * first (cheaper: one file, no brace matching), then every `.tf` file in
 * directory order for a `live { }` block nested in a `terraform { }` block.
 * Returns the first estate name found; a directory with no `.tf` files and
 * no sidecar (or one this function cannot read) yields `undefined` rather
 * than throwing, since this is a best-effort check, not the authoritative parse.
 */
export function detectLiveEstate(dir: string): string | undefined {
  const sidecarPath = join(dir, LIVE_SIDECAR_FILENAME);
  if (existsSync(sidecarPath)) {
    try {
      const estate = extractEstateAttr(readFileSync(sidecarPath, "utf-8"));
      if (estate) return estate;
    } catch {
      // fall through to the in-block form
    }
  }

  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".tf"))
      .sort();
  } catch {
    return undefined;
  }

  for (const name of names) {
    let source: string;
    try {
      source = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const terraformBlock = extractBalancedBlock(source, "terraform");
    if (terraformBlock === undefined) continue;
    const liveBlock = extractBalancedBlock(terraformBlock, "live");
    if (liveBlock === undefined) continue;
    const estate = extractEstateAttr(liveBlock);
    if (estate) return estate;
  }

  return undefined;
}

/**
 * The `undeclared_tagged`/`undeclared_untagged` verbs a live root's `policy {
 * }` block assigns, or `undefined` when the directory declares no `policy`
 * block at all (#2106). Same best-effort posture as {@link detectLiveEstate}:
 * a plain read of the in-block form only (the `estate.chdf.hcl` sidecar's own
 * `policy` block, if choudoufu ever admits one there, is not read here — a
 * known, narrower gap than the estate check above, which does read the
 * sidecar). `TerraformApplyOp` (`../../composites/terraform-apply-op.ts`)
 * uses this to refuse a root whose `policy` sets
 * `undeclared_untagged = "delete"` outright, at build time, before any
 * activity runs; TF026 (`../../lint/post-synth/tf026.ts`) checks the same
 * block's `undeclared_tagged` verb against a root's declared `delete: "never"`
 * from the parsed HCL entities instead, since a post-synth check already has
 * the block body in hand and has no need of this file-reading version.
 */
export interface LivePolicyVerbs {
  /** The `undeclared_tagged` quadrant's verb, verbatim, or `undefined` when the attribute is absent (defaults to `"delete"`). */
  undeclaredTagged?: string;
  /** The `undeclared_untagged` quadrant's verb, verbatim, or `undefined` when the attribute is absent. */
  undeclaredUntagged?: string;
}

export function detectLivePolicyVerbs(dir: string): LivePolicyVerbs | undefined {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".tf"))
      .sort();
  } catch {
    return undefined;
  }

  for (const name of names) {
    let source: string;
    try {
      source = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const terraformBlock = extractBalancedBlock(source, "terraform");
    if (terraformBlock === undefined) continue;
    const liveBlock = extractBalancedBlock(terraformBlock, "live");
    if (liveBlock === undefined) continue;
    const policyBlock = extractBalancedBlock(liveBlock, "policy");
    if (policyBlock === undefined) continue;
    return {
      undeclaredTagged: extractQuotedAttr(policyBlock, "undeclared_tagged"),
      undeclaredUntagged: extractQuotedAttr(policyBlock, "undeclared_untagged"),
    };
  }

  return undefined;
}
