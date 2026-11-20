/**
 * The floors of the pulumi lexicon's parts: for each part a product may
 * feature-detect on, the first release of `@intentius/chant-lexicon-pulumi`
 * that has it. Each package has its own version (#5138), so these are
 * versions of the pulumi lexicon, not of chant core. chant core's floor table
 * (`@intentius/chant/floor-table`) lists them beside core's with the package
 * each belongs to, and `chant dev dead-guards` reads them against a product's
 * pin on the lexicon.
 *
 * Only this file is read for the table (`scripts/floor-table.ts`). A floor
 * that names the next release imports `NEXT_RELEASE`, and the entries that
 * serve a part re-export its floor by name from `./index`.
 */
import { NEXT_RELEASE } from "@intentius/chant/release-floors";

/**
 * The first pulumi lexicon release with a `referenceCatalog` (`./reference-catalog`): how the aws, gcp, azure and kubernetes providers' resources name each other by ARN, id and name, and the inputs and outputs a stack export's nodes carry for it to read (#5330).
 */
export const PULUMI_REFERENCE_CATALOG_FLOOR = NEXT_RELEASE;

/**
 * The first pulumi lexicon release with `pulumiCostHold` (`./cost-hold`) and a `planJson` on `pulumi-up`'s artifact: the preview JSON a wave's cost hold hands a user-named command as `{planJson}` (#5341).
 */
export const PULUMI_COST_HOLD_FLOOR = NEXT_RELEASE;
