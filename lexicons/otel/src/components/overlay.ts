/**
 * How a built-in's hand-written definition adds to its generated config type
 * (#3361).
 *
 * The config types come from upstream `config.schema.yaml`
 * (`src/generated/index.ts`). A schema cannot say everything the component
 * needs, so a `defineBuiltin` file may overlay the generated type, and only
 * for one of these reasons, stated where it is used:
 *
 * - upstream publishes no schema for a `$ref`, so the generated field is
 *   `unknown` (the health_check extension, hostmetrics' scrapers, the filter
 *   processor's conditions);
 * - the field is a tagged union upstream writes as a struct of optional
 *   members, and the component's checks narrow on the tag (tail_sampling's
 *   policies, signaltometrics' metric types);
 * - the component cannot start without the field. `schemagen` writes no
 *   `required`, so {@link Require} restores it.
 */

/** `S` with the keys of `O` replaced by `O`'s. */
export type Overlay<S, O> = Omit<S, keyof O> & O;

/** `S` with keys `K` required. */
export type Require<S, K extends keyof S> = Omit<S, K> & { [P in K]-?: Exclude<S[P], undefined> };
