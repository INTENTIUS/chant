/**
 * Shared reading helpers for the single-block post-synth checks (#2110).
 *
 * Thirteen of the fourteen rules in that issue do the same three things: pick
 * the entities of one block type out of `ctx.entities`, read one attribute of
 * each body, and report. This module is those three things, so a rule file is
 * its condition and its message and nothing else. It exports no
 * `PostSynthCheck`, so the generated barrel skips it (see
 * `packages/core/src/codegen/generate-post-synth-barrel.ts`).
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { BlockBody, TerraformEntity } from "../../hcl/parse";

/** One parsed block, with the entity key the diagnostic reports against. */
export interface TerraformBlock {
  /** `ctx.entities` key: `<root>/<address>`. */
  key: string;
  address: string;
  body: BlockBody;
  file: string;
  root: string;
  /** The raw text of the file this block came from (see `TerraformEntity.props`). */
  source: string;
}

/** Every block of one entity type, in `ctx.entities` order. */
export function blocksOfType(ctx: PostSynthContext, entityType: string): TerraformBlock[] {
  const blocks: TerraformBlock[] = [];
  for (const [key, entity] of ctx.entities) {
    if (entity.entityType !== entityType) continue;
    if (!isResourceDeclarable(entity)) continue;
    const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
    blocks.push({
      key,
      address: typeof props.address === "string" ? props.address : key,
      body: (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody,
      file: typeof props.file === "string" ? props.file : "",
      root: typeof props.root === "string" ? props.root : "",
      source: typeof props.source === "string" ? props.source : "",
    });
  }
  return blocks;
}

/** Blocks of several types at once, in the order the types are given. */
export function blocksOfTypes(ctx: PostSynthContext, entityTypes: string[]): TerraformBlock[] {
  return entityTypes.flatMap((t) => blocksOfType(ctx, t));
}

/** The name half of a `var.<name>` / `output.<name>` address. */
export function blockName(address: string): string {
  const dot = address.indexOf(".");
  return dot === -1 ? address : address.slice(dot + 1);
}

/**
 * The bodies of a nested block (`lifecycle`, `validation`, a provider's
 * `assume_role`). hcl2json encodes a repeatable block as an array of bodies
 * and a singleton as a bare object, so both are normalized to an array here.
 */
export function nestedBodies(body: BlockBody, key: string): BlockBody[] {
  const value = body[key];
  if (Array.isArray(value)) return value.filter((v): v is BlockBody => typeof v === "object" && v !== null && !Array.isArray(v));
  if (typeof value === "object" && value !== null) return [value as BlockBody];
  return [];
}

/** Is this attribute value a string that says nothing? */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** One scalar attribute found by {@link walkAttributes}. */
export interface Attribute {
  /** The attribute's own name (the last path segment). */
  name: string;
  /** Dotted path from the block body, e.g. `connection.password`. */
  path: string;
  value: unknown;
}

/**
 * Every scalar attribute in a block body, descending through nested blocks so
 * a credential inside `connection {}` or `assume_role {}` is not invisible.
 * Depth-limited: a Terraform block nests a handful of levels at most, and an
 * unbounded walk over a large body buys nothing.
 */
export function walkAttributes(body: BlockBody, maxDepth = 3): Attribute[] {
  const out: Attribute[] = [];
  const visit = (value: unknown, path: string, name: string, depth: number): void => {
    if (Array.isArray(value)) {
      if (depth > maxDepth) return;
      for (const item of value) visit(item, path, name, depth);
      return;
    }
    if (typeof value === "object" && value !== null) {
      if (depth >= maxDepth) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, path === "" ? k : `${path}.${k}`, k, depth + 1);
      }
      return;
    }
    if (path !== "") out.push({ name, path, value });
  };
  visit(body, "", "", 0);
  return out;
}
