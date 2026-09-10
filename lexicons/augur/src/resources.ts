/**
 * What this lexicon declares: the question, not the estate.
 *
 * Every other lexicon declares resources a substrate will hold. augur declares
 * none, because the estate it predicts is already declared — by aws, by k8s, by
 * whichever lexicons a project uses — and a second, augur-flavoured copy of a
 * bucket would be a copy to keep in sync. What is *not* declared anywhere else
 * is the question: at what traffic level should this estate be predicted.
 *
 * So there is one resource, {@link Profile}, and it carries a traffic level
 * verbatim. `chant build` writes the declared profiles as a small JSON document
 * (`./serializer.ts`), which is what an Op (#2358) iterates when it wants a
 * predicted delta at each level a project cares about.
 *
 * Hand-written rather than generated, for the reason `lexicons/terraform`'s
 * `codegen/generate.ts` writes an empty registry: there is no upstream schema
 * to generate from. A behaviour engine's request shape is this repository's own
 * (`./request.ts`), and one resource with two properties does not become truer
 * for having been emitted by a pipeline.
 */

import { createResource } from "@intentius/chant/runtime";

/** The `entityType` a profile carries. Named once, since `./mapping.ts` declares it unmapped by it. */
export const PROFILE_TYPE = "Augur::Profile";

/**
 * A traffic level to predict the estate at.
 *
 * ```ts
 * export const peak = new Profile({
 *   traffic: "1000 rps, p99",
 *   description: "Friday evening, the checkout path only",
 * });
 * ```
 *
 * `traffic` is a string the engine reads and chant does not parse — `100 rps,
 * p50`, `peak hour, black friday`, `steady state`. It is the same string that
 * reaches `PredictBehaviourOptions.traffic`, and it is not a number on purpose:
 * a bare `1000` is the shape most likely to be read as an amount and quoted as
 * a bill, which is the one misreading the whole contract is built to prevent.
 * AUG001 reports a profile that states one anyway.
 */
export const Profile = createResource(PROFILE_TYPE, "augur", {});
