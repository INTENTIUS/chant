/**
 * The floors of the aws lexicon's parts: for each part a product may
 * feature-detect on, the first release of `@intentius/chant-lexicon-aws`
 * that has it. Each package has its own version (#5138), so these are
 * versions of the aws lexicon, not of chant core. chant core's floor table
 * (`@intentius/chant/floor-table`) lists them beside core's with the package
 * each belongs to, and `chant dev dead-guards` reads them against a product's
 * pin on the lexicon.
 *
 * Only this file is read for the table (`scripts/floor-table.ts`). A floor
 * that names the next release imports `NEXT_RELEASE`, and the entries that
 * serve a part re-export its floor by name from `./index`. Here
 * `NEXT_RELEASE` names the next aws lexicon release, not core's: this
 * package's prepack builds with each such floor written as the lexicon
 * release that ships it (`scripts/release-floors.ts --lexicon aws --pack`).
 */
import { NEXT_RELEASE } from "@intentius/chant/release-floors";

/**
 * The first aws lexicon release whose `cloudformation` workspace member reads deployed stacks: a `cloudformation-stacks.json` beside the member, `{ "stacks": ["<name>"], "region": "<region>" }`, draws each stack's processed template as nodes and edges, with `meta.awsMember.stacks` carrying each stack's status, outputs and resources with their physical ids, and a stack that cannot be read named with the credentials and region it needs (#5455).
 */
export const AWS_STACK_MEMBER_FLOOR = NEXT_RELEASE;
