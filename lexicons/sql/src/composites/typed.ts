/**
 * chant#3787 — the call signature a composite is typed with, so a member's
 * `.columns` are the generated `SqlSchema` entry for the name its props give
 * it. `users.table.columns.emial` then fails tsc as `table<"app.users">`'s
 * would. The definition is unchanged at run time: `Composite`'s third type
 * argument carries this signature in front of the plain one.
 */

import type { CompositeDefinition, CompositeFactoryMembers, CompositeInstance } from "@intentius/chant/composite";

/** What a typed composite call returns: the instance, with its members' types. */
export type Instance<M extends CompositeFactoryMembers> = CompositeInstance<M> & M;

/** A composite definition whose precise, generic `Call` signature is tried before the plain `(props: P) => M`. */
export type TypedComposite<P, M extends CompositeFactoryMembers, Call> = Call & CompositeDefinition<P, M>;
