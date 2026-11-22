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

/**
 * The first aws lexicon release whose cloudformation and cdk members publish `stateLocations` on their graph meta, so `chant workspace state` says where a member's state lives: the stack and its region, `reachable` when the stack was read and `unreachable` with the reason when it was not (#5456).
 */
export const AWS_STATE_LOCATIONS_FLOOR = NEXT_RELEASE;

/**
 * The first aws lexicon release whose live read lists each declared ECS service's tasks (`ListTasks`, `DescribeTasks`) as undeclared nodes owned by the service (`ownerChain: { root: "declared", entity }`), so `chant graph --live --overlay` paints them `runtime`: each with its task definition revision, the service's current one, `staleRevision` while a rolling deploy has a task behind, and a note when a service has more than 100 tasks (#5448).
 */
export const AWS_ECS_TASKS_FLOOR = NEXT_RELEASE;
