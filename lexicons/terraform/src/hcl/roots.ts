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
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import type { TerraformRootConfig } from "../config";
import { LIVE_TYPE, parseTerraformRootDir } from "./parse";

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
  /** Injectable parser (tests); defaults to core's lazy-loaded `@cdktf/hcl2json`. */
  hcl2json?: Hcl2Json;
}

/**
 * Parse each configured root into entities keyed `<root>/<address>`. Roots are
 * visited in declaration order, and one root's failure never stops the next.
 */
export async function renderTerraformRoots(
  opts: RenderTerraformRootsOptions,
): Promise<TerraformRootsResult> {
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  for (const [name, root] of Object.entries(opts.roots)) {
    const dir = isAbsolute(root.dir) ? root.dir : resolve(opts.projectRoot, root.dir);

    if (!existsSync(dir)) {
      warnings.push(`terraform.roots.${name}: directory not found at ${dir}, no entities contributed`);
      continue;
    }

    try {
      const parsed = await parseTerraformRootDir(dir, name, opts.hcl2json, {
        binary: opts.binary,
        workspace: root.workspace,
      });
      for (const [key, entity] of parsed) entities.set(key, entity);

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

  return { entities, warnings };
}
