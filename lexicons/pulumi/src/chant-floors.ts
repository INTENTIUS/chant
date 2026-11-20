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

/**
 * The first pulumi lexicon release with the preview depth of `describeResources` (`CHANT_PULUMI_OBSERVE=preview`, `./preview-observation`): `pulumi preview --json` (or plunge's) marks each node with its planned operation in the terraform plan observation's attribute names, a stack with no export gets its nodes from the preview marked `planned`, and `rootReads["pulumi.members.<member>"]` says why a preview did not answer (#5332).
 */
export const PULUMI_PREVIEW_OBSERVATION_FLOOR = NEXT_RELEASE;

/**
<<<<<<< HEAD
 * The first pulumi lexicon release whose `classifyDisruption` classifies a
 * planned update from a preview's steps (in place, replace, destroy), with
 * `pulumiDisruptionQueries` for a preview in hand, and whose `healthTargets`
 * reads a stack's covered resources through the aws, azure and gcp health
 * reads with ids from its export (#5338).
 */
export const PULUMI_HEALTH_DISRUPTION_FLOOR = NEXT_RELEASE;

/**
 * The first pulumi lexicon release whose `pulumi-up` reports its `StackReference` reads through `graphReads` (`./pulumi-up`), so `chant graph --components` and `chant workspace graph` draw an edge from a stack to each stack it reads, naming the output, and a node marked external for a stack nothing applies (#5331).
 */
export const PULUMI_STACK_REFERENCE_GRAPH_FLOOR = NEXT_RELEASE;
