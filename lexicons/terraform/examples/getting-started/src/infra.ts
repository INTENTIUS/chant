/**
 * An existing Terraform root module, joined to a chant build.
 *
 * The estate is the `terraform/` directory next to this one: ordinary HCL,
 * unmodified, still applied by `terraform apply`. What chant adds is that the
 * blocks become entities, so the post-synth checks see them (TF001 passes here
 * because the root declares a `backend "local"`), and nothing is emitted back
 * over the `.tf` files.
 *
 * `chant build` normally contributes those entities on its own, from the
 * `terraform.roots` map in `chant.config.ts` next door: the plugin's
 * `buildRoots()` hook parses each configured root before serialization. This
 * file calls the same parse directly because that hook is bound by the CLI,
 * and the example harness behind `chant dev check-lexicon` builds `src/` alone
 * (see `checkExamplesBuild` in packages/core), so it never binds it. Same
 * function, same entities, one root, spelled out.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTerraformRootDir } from "@intentius/chant-lexicon-terraform";

const rootDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "terraform");

/**
 * Every block of the `app` root: the `terraform` block, the `null` provider,
 * and the two `null_resource`s. Exported as an array, so discovery indexes
 * them as `app_0`, `app_1` and so on.
 */
export const app = [...(await parseTerraformRootDir(rootDir, "app")).values()];
