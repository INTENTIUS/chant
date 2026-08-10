/**
 * The dogwood upstream pin.
 *
 * Not a `upstreamPin` on the plugin: that slot belongs to the cedar grammar
 * (`@cedar-policy/cedar-wasm`, see `../spec/pin.ts`), and self-upgrade tooling
 * bumps exactly one thing per lexicon. Dogwood's pin is a git SHA recorded by
 * #1657, because upstream has no version to key off — zero tags, zero
 * releases, and a workspace version of `1.0.0` that is an Amazon-internal
 * package artifact every future sync will also report.
 *
 * The blob hashes are the narrow content pin the #1657 report recommends. The
 * whole tree hash moves on every sync including docs-only ones, which makes it
 * too noisy to gate on; these seven files are the surface chant actually
 * depends on. The three `.pest` grammars pin the language, `default_macros.dw`
 * pins the standard aggregate library (which is a file a sync can edit and a
 * caller can replace with `--macros`), and the three `dogwood-cli/src` files
 * pin the JSON report structs that are #1659's integration surface.
 *
 * Movement risk is structural, not incidental: content arrives as squashed
 * "Sync from internal source" commits from a publish bot, against a repository
 * nobody outside Amazon can see, with no changelog and no version bump.
 */

/** The pinned upstream revision and the files chant's surface is built against. */
export const DOGWOOD_UPSTREAM = {
  owner: "dogwood-policy",
  repo: "dogwood",
  /** Default-branch SHA verified in #1657 (committed 2026-08-06). */
  revision: "5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c",
  license: "Apache-2.0",
  /** Git blob hashes at {@link revision} — the narrow content pin. */
  contents: {
    "dogwood-language/src/parser/grammar.pest": "adb0801303ee1b735585fe22a5d85175ecf6772c",
    "dogwood-language/src/extension/temporal/grammar.pest": "dc31fe1634b5c37173f0a999619e9834069b7a22",
    "dogwood-language/src/event_schema/grammar.pest": "bd3b064447dc0d09cc2f8eb28a7c657e746cc8a2",
    "dogwood-language/configuration/default_macros.dw": "ecd67e5edcd566aa66b05ad51bc472afbaf22a7a",
    "dogwood-cli/src/ops.rs": "2924c7eb0e569a745ff19c2d84cbba782fc56502",
    "dogwood-cli/src/main.rs": "bfd68c9ff05883ed48e5738f658b5925542d817d",
    "dogwood-cli/src/error.rs": "43f12afbbf25ad94e25130c83227eefd86f8d516",
  },
} as const;
