/**
 * Terraform build roots.
 *
 * An estate that keeps its `.tf` tree has no typed chant source for it. What
 * it can declare is the directory: each entry in `terraform.roots` names a
 * root module that parses at build time into entities, so the blocks are
 * serialized into the build output and seen by the post-synth checks. Same
 * shape `lexicons/k8s/src/kustomize/root.ts` uses for kustomize overlays: the
 * render lives here, the plugin's `buildRoots()` member stays thin.
 *
 * Unlike the kustomize renderer, a missing directory or a `.tf` the parser
 * refuses is a warning and zero entities for that root, never a throw. Reading
 * someone else's estate is the whole job here, and half of it parsing is more
 * useful than none of it, especially when the audit path (#2085) walks
 * repositories it did not write.
 *
 * A root's own directory is not the end of the parse: a `module` block with a
 * local source is followed into its directory and parsed as a child scope of
 * the root (#2112). `./descend.ts` owns that walk and every refusal in it; the
 * refusals surface here as this render's warnings.
 *
 * One pass runs after every root has parsed: `./edges.ts` resolves each
 * block's `${...}` references into the entity keys they name, so the graph IR
 * has edges to draw (#2265). It runs here rather than inside the per-file
 * parse because an edge's target may be a block in a file, or a child module,
 * that has not been read yet.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import type { TerraformRootConfig } from "../config";
import { LIVE_TYPE, parseTerraformRootDir } from "./parse";
import { descendModules, resolveCallModuleType, type CallModuleType } from "./descend";
import { resolveEntityReferences } from "./edges";

export interface TerraformRootsResult {
  entities: Map<string, Declarable>;
  warnings: string[];
}

export interface RenderTerraformRootsOptions {
  /** Directory the project config was loaded from; relative `dir` resolves against it. */
  projectRoot: string;
  /** `terraform.roots`: name to root-module config. */
  roots: Readonly<Record<string, TerraformRootConfig>>;
  /**
   * `terraform.binary`. A root is live only when this is `"choudoufu"` and it
   * declares an estate; anything else runs stock (#2103).
   */
  binary?: string;
  /**
   * `terraform.callModuleType` (#2112): how far each root's parse follows its
   * `module` calls. Defaults to `"local"`, so a module sourced from `./` or
   * `../` is parsed as a child scope of the root that calls it.
   */
  callModuleType?: CallModuleType;
  /** Injectable parser (tests); defaults to core's lazy-loaded `@cdktf/hcl2json`. */
  hcl2json?: Hcl2Json;
}

/**
 * Parse each configured root into entities keyed `<root>/<address>`, plus its
 * local child modules, keyed `<root>/module.<name>/<address>` (#2112). Roots
 * are visited in declaration order, and one root's failure never stops the
 * next.
 */
export async function renderTerraformRoots(
  opts: RenderTerraformRootsOptions,
): Promise<TerraformRootsResult> {
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  // One verdict for the whole render: the mode is a project-level setting, so
  // a refused `"all"` is said once rather than once per root (#2112).
  const callModuleType = resolveCallModuleType(opts.callModuleType);
  if (callModuleType.warning) warnings.push(callModuleType.warning);

  for (const [name, root] of Object.entries(opts.roots)) {
    const dir = isAbsolute(root.dir) ? root.dir : resolve(opts.projectRoot, root.dir);

    if (!existsSync(dir)) {
      warnings.push(`terraform.roots.${name}: directory not found at ${dir}, no entities contributed`);
      continue;
    }

    try {
      const modeOptions = { binary: opts.binary, workspace: root.workspace, delete: root.delete };
      const parsed = await parseTerraformRootDir(dir, name, opts.hcl2json, modeOptions);
      for (const [key, entity] of parsed) entities.set(key, entity);

      // Local child modules, keyed `<root>/module.<name>/<address>` (#2112).
      // Their refusals are warnings on the root that called them, since the
      // call site is where a reader can act on one.
      const descended = await descendModules(parsed, {
        dir,
        root: name,
        projectRoot: opts.projectRoot,
        callModuleType: callModuleType.effective,
        hcl2json: opts.hcl2json,
        modeOptions,
      });
      for (const [key, entity] of descended.entities) entities.set(key, entity);
      warnings.push(...descended.warnings);

      // A `live` block or `estate.chdf.hcl` sidecar only takes effect under
      // choudoufu; under any other binary it parses fine but is inert, which
      // is worth a warning rather than silence (#2103).
      for (const entity of parsed.values()) {
        if (entity.entityType !== LIVE_TYPE || !isResourceDeclarable(entity)) continue;
        if ((entity.props as { mode?: string }).mode === "state") {
          warnings.push(
            `terraform.roots.${name}: declares a live estate (a \`live\` block or ${JSON.stringify(
              "estate.chdf.hcl",
            )} sidecar), but terraform.binary is ${JSON.stringify(opts.binary ?? "terraform")}, not "choudoufu", so the live declaration is inert.`,
          );
        }
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`terraform.roots.${name}: could not parse ${dir}, ${message}`);
    }
  }

  // Every root and every descended child module is parsed by now, which is
  // what reference resolution needs: an edge points at an entity key, and the
  // keys only all exist once the last descent has run (#2265). One pass over
  // the whole map, one expression cache, resolution still bounded to each
  // block's own module scope.
  await resolveEntityReferences(entities, opts.hcl2json);

  return { entities, warnings };
}
