/**
 * Descend into local child modules (chant #2112).
 *
 * `parseTerraformRootDir` reads one directory, non-recursively, which is
 * Terraform's own root-module scoping and the right unit for a root-scoped
 * check like TF001. Four rules need more than that: TF014 and TF015 are about
 * what a CHILD module may contain, and TF020 needs every reference in a scope
 * before it can call a declaration unused. This module supplies the missing
 * half: a `module` block whose `source` is a local path names a directory,
 * and that directory parses with the same `blocksToEntities` into entities
 * keyed `<root>/module.<name>/<address>` carrying `props.callers`.
 *
 * ## What is followed, and what is not
 *
 * tflint's `--call-module-type` (three states, defaulting to `local`,
 * https://github.com/terraform-linters/tflint/blob/master/docs/user-guide/calling-modules.md)
 * is the model:
 *
 * - `local` (the default): only `./` and `../` sources are read. A registry
 *   or git source is NOT fetched, so its contents are never linted and every
 *   finding about it is reported against the call site instead, which is
 *   where TF004 and TF005 already report. The skipped call sites are named in
 *   a warning rather than passed over in silence.
 * - `none`: no descent at all. A root then parses exactly as it did before
 *   this module existed.
 * - `all`: reserved. tflint means "fetch registry and git modules too", which
 *   needs a `terraform init`/`terraform get` first so the modules are on disk
 *   under `.terraform`. chant fetches nothing, so this is refused with a
 *   message rather than quietly behaving like `local`.
 *
 * Two more refusals, both about staying inside the repository being read:
 *
 * - A source that resolves outside the project root is refused. `../` is a
 *   legal Terraform source and a repository may legitimately share modules
 *   between sibling roots, but reading above the project root means linting
 *   files the project does not own, so the boundary is the project root and
 *   crossing it is a warning, not a parse.
 * - A source already on the current call chain is a cycle (`a` calls `b`
 *   calls `a`) and stops there. The visited set is per chain, on RESOLVED
 *   paths, so one module called from two different places is still read once
 *   per call site, each under its own `module.<name>` key, the way
 *   `terraform show -json` reports two `child_modules[]` entries for it.
 *
 * Everything here is best effort, like `./roots.ts`: an unreadable or
 * unparseable child module is a warning and no entities, never a throw, since
 * half a root parsed is more useful than none of it.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { classifyModuleSource } from "../lint/post-synth/module-source";
import {
  MODULE_TYPE,
  parseTerraformRootDir,
  type BlockBody,
  type TerraformEntity,
  type TerraformRootModeOptions,
} from "./parse";

/** tflint's `--call-module-type`, with the same three states and the same default. */
export type CallModuleType = "local" | "none" | "all";

/** What a caller gets when it asks for a mode chant cannot serve. */
export interface ResolvedCallModuleType {
  /** The mode actually used. `"all"` never survives here. */
  effective: "local" | "none";
  /** Set when the requested mode was refused, ready to push onto a warning list. */
  warning?: string;
}

/**
 * Resolve the configured `callModuleType` into one this lexicon implements.
 * `"all"` is refused with a message naming what it would need; everything
 * else passes through, and an absent value is `"local"`, tflint's default.
 */
export function resolveCallModuleType(value?: CallModuleType): ResolvedCallModuleType {
  if (value === "none") return { effective: "none" };
  if (value === "all") {
    return {
      effective: "none",
      warning:
        'terraform.callModuleType: "all" is not supported. It means "descend into registry and git ' +
        "modules too\", which requires fetching them (`terraform init`/`terraform get`) first, and chant " +
        'fetches nothing. Use "local" (the default, relative-path sources only) or "none". No module was descended into.',
    };
  }
  return { effective: "local" };
}

/** Options for {@link descendModules}. */
export interface DescendOptions {
  /** Directory the scope's own `.tf` files were read from. */
  dir: string;
  /** Root name, the first segment of every entity key. */
  root: string;
  /** Boundary: a source resolving outside this directory is refused. */
  projectRoot: string;
  /** Resolved mode. `"none"` returns immediately with nothing. */
  callModuleType?: "local" | "none";
  /** Injectable parser (tests); defaults to core's lazy-loaded `@cdktf/hcl2json`. */
  hcl2json?: Hcl2Json;
  /** Mode facts stamped onto the child's entities, exactly as on the root's. */
  modeOptions?: TerraformRootModeOptions;
  /** How deep to follow calls. A guard against a pathological tree, not a policy. */
  maxDepth?: number;
}

export interface DescendResult {
  /** The child modules' entities, keyed `<root>/module.<name>/<address>`. */
  entities: Map<string, Declarable>;
  /** One line per refusal or skip, in the order they were met. */
  warnings: string[];
}

const DEFAULT_MAX_DEPTH = 8;

/** Is `path` inside `boundary` (or the boundary itself)? */
function isInside(boundary: string, path: string): boolean {
  const rel = relative(boundary, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The `module` blocks of one scope, in `ctx.entities` order, with their sources read. */
function moduleCallsOf(entities: Map<string, Declarable>): Array<{ address: string; source?: string }> {
  const calls: Array<{ address: string; source?: string }> = [];
  for (const entity of entities.values()) {
    if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
    const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
    const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
    calls.push({
      address: typeof props.address === "string" ? props.address : "module.?",
      source: typeof body.source === "string" ? body.source : undefined,
    });
  }
  return calls;
}

/**
 * The mode and estate the scope's own entities carry.
 *
 * A child module directory holds no `live` block and no `estate.chdf.hcl`
 * sidecar (choudoufu reads the estate declaration from the root's directory,
 * and only there), so parsing it alone always lands on `mode: "state"`. The
 * root's verdict is the root's, one root one mode, so it is copied down onto
 * every descended entity rather than re-derived from files that cannot carry
 * it.
 */
function scopeMode(entities: Map<string, Declarable>): { mode?: string; estate?: string } {
  for (const entity of entities.values()) {
    if (!isResourceDeclarable(entity)) continue;
    const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
    if (typeof props.mode !== "string") continue;
    return { mode: props.mode, ...(typeof props.estate === "string" ? { estate: props.estate } : {}) };
  }
  return {};
}

/** Rebuild `entity` with the parent scope's mode and estate on its props. */
function withMode(entity: Declarable, mode: { mode?: string; estate?: string }): Declarable {
  if (mode.mode === undefined || !isResourceDeclarable(entity)) return entity;
  const te = entity as TerraformEntity;
  return {
    ...te,
    props: { ...te.props, mode: mode.mode as TerraformEntity["props"]["mode"], ...(mode.estate !== undefined ? { estate: mode.estate } : {}) },
  } as Declarable;
}

/**
 * Parse every local child module reachable from `scope`, recursively.
 *
 * `scope` is one already-parsed module scope: the root's own entities on the
 * first call, a child's on a recursive one. Returned entities are the
 * children's only, never the scope's own, so a caller merges them into the
 * map it already has.
 */
export async function descendModules(
  scope: Map<string, Declarable>,
  opts: DescendOptions,
): Promise<DescendResult> {
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];
  const mode = opts.callModuleType ?? "local";
  if (mode === "none") return { entities, warnings };

  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const where = `terraform.roots.${opts.root}`;
  // The project root is the boundary, except for a root module configured
  // with a `dir` outside the project entirely (an absolute path to an estate
  // kept elsewhere): there the root's own directory is the boundary, since
  // the project root would refuse every module the root has.
  const boundary = isInside(opts.projectRoot, opts.dir) ? resolve(opts.projectRoot) : resolve(opts.dir);

  /** One scope's calls, with the chain that reached it and the paths already on that chain. */
  const walk = async (
    scopeEntities: Map<string, Declarable>,
    dir: string,
    callers: readonly string[],
    onChain: readonly string[],
  ): Promise<void> => {
    const notFollowed: string[] = [];

    for (const call of moduleCallsOf(scopeEntities)) {
      if (call.source === undefined) continue;
      const classified = classifyModuleSource(call.source);
      if (classified.kind !== "local") {
        notFollowed.push(`${call.address} (${call.source})`);
        continue;
      }

      const target = resolve(dir, call.source);
      if (!isInside(boundary, target)) {
        warnings.push(
          `${where}: ${call.address} sources ${JSON.stringify(call.source)}, which resolves outside the project ` +
            `root (${target}). chant does not read modules from outside the project it was pointed at, so that ` +
            "module is not parsed and any finding in it is not reported.",
        );
        continue;
      }
      if (onChain.includes(target)) {
        warnings.push(
          `${where}: ${call.address} sources ${JSON.stringify(call.source)}, which is already on this call chain ` +
            `(${[...callers, call.address].join(" -> ")}). That is a cycle, so the descent stops here.`,
        );
        continue;
      }
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        warnings.push(
          `${where}: ${call.address} sources ${JSON.stringify(call.source)}, but no directory exists at ${target}, ` +
            "so the module is not parsed.",
        );
        continue;
      }
      if (callers.length >= maxDepth) {
        warnings.push(
          `${where}: ${call.address} is more than ${maxDepth} module calls deep (${callers.join(" -> ")}), ` +
            "so the descent stops here.",
        );
        continue;
      }

      const chain = [...callers, call.address];
      let child: Map<string, Declarable>;
      try {
        child = await parseTerraformRootDir(target, opts.root, opts.hcl2json, opts.modeOptions, chain);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`${where}: could not parse ${call.address} at ${target}, ${message}`);
        continue;
      }
      const mode = scopeMode(scopeEntities);
      for (const [key, entity] of child) {
        const stamped = withMode(entity, mode);
        child.set(key, stamped);
        entities.set(key, stamped);
      }
      await walk(child, target, chain, [...onChain, target]);
    }

    if (notFollowed.length > 0) {
      warnings.push(
        `${where}: not descending into ${notFollowed.join(", ")}. The source is a registry or git module and chant ` +
          "fetches nothing, so the module's own contents are unchecked and every finding about it is reported " +
          "against the module block at the call site.",
      );
    }
  };

  await walk(scope, opts.dir, [], [resolve(opts.dir)]);
  return { entities, warnings };
}
