# @intentius/chant-lexicon-augur

augur lexicon plugin for [chant](https://github.com/intentius/chant) — a
project's resource graph, serialized into a behaviour engine's request, with a
coverage table saying what reaches the engine and what does not.

Part of [chant #2355](https://github.com/INTENTIUS/chant/issues/2355), the
behaviour overlay: cost per hour, headroom, an error-rate expectation and a
resilience verdict, per entity, at a traffic level the caller names. augur is
the lexicon half ([#2357](https://github.com/INTENTIUS/chant/issues/2357)) and
the first implementation of `predictBehaviour()`, the fourth observation method
the plugin contract added in
[#2356](https://github.com/INTENTIUS/chant/issues/2356).

## What it declares

One resource, and it is the question rather than the estate:

```ts
import { Profile } from "@intentius/chant-lexicon-augur";

export const peak = new Profile({
  traffic: "1000 rps, p99",
  description: "Friday evening, the hour the estate is sized for",
});
```

The estate is already declared, by aws or k8s or whatever a project uses. augur
reads it. `chant build` writes the declared levels as JSON; nothing reaches a
network at build time and the bytes are identical on a re-run, which is what
makes a declared-versus-live delta a statement about the estate rather than
about the run.

## The coverage table

Not every kind chant knows about has an equivalent on an engine's side, so
`src/mapping.ts` is a table rather than a heuristic, and it has three states:

| Verdict | Where the entity lands |
|---|---|
| mapped | `entities`, with figures |
| declared unmapped | `unpredicted`, `unsupported-kind`, naming the kind and why it carries no rate |
| no row at all | `unpredicted`, `unsupported-kind`, saying augur has never looked and where to add the row |

The last two are different answers, not one written twice: a decision a reader
can act on, versus a gap in this lexicon. Neither is a dropped entity and
neither is a zero.

Full table: [the coverage page](https://intentius.github.io/chant/lexicons/augur/coverage/),
generated from the code and checked against it by `src/coverage-doc.test.ts`.

## Reaching an engine

```bash
export CHANT_BEHAVIOUR_ENGINE=augur-engine     # a command on PATH
```

Resolved most specific first: `CHANT_BEHAVIOUR_ENGINE_AUGUR`, then
`CHANT_BEHAVIOUR_ENGINE`, then `BEHAVIOUR_ENGINE`. The address is an address,
not a credential — the engine is never handed one and never writes.

A command on PATH is dialled by piping the request to its stdin and reading the
answer from its stdout, with an environment holding `PATH` and nothing else: a
subprocess inheriting `process.env` would walk straight around the
request-side credential screen. A URL is dialled by the contract's HTTP
transport (`packages/core/src/behaviour-http.ts`) with a bearer token from
`CHANT_BEHAVIOUR_TOKEN_AUGUR`, then `CHANT_BEHAVIOUR_TOKEN`, then
`BEHAVIOUR_TOKEN`. The token travels in a header and appears in no message; a
URL named with no token set is refused by name before anything is sent.

With no engine named, augur refuses and says which variable to set. It never
reports an estate that costs nothing.

## Runtime observation — N/A

`describeResources()`, `observeResourcesDeep()` and `listArtifacts()` report
what a substrate holds. augur holds nothing: it asks an engine what would
happen at a level nobody has run. Declaring one of the three returning an empty
list would pass a check while claiming a read that never happens.

## Development

```bash
npm run generate --prefix lexicons/augur    # writes the (empty) registry
npm run bundle   --prefix lexicons/augur    # dist/
npm run docs     --prefix lexicons/augur    # the docs site
npm run fixtures --prefix lexicons/augur    # regenerate the golden request
npx vitest run lexicons/augur
```

`src/__fixtures__/golden-request.json` is the request built from
`examples/getting-started`, committed so a change to the coverage table or the
wire shape arrives as a diff a reviewer reads. Regenerate it deliberately, with
`npm run fixtures`, never from a test.
