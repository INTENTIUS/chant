# fold-adversarial

A differential fixture, not a tutorial. Nothing here is a pattern to copy — several files are
deliberately wrong, and one of them throws.

The fold/run differential (`just fold-differential`) builds every source directory under
`examples/*/src` and `lexicons/*/examples/*/src` twice, once with `{ fold: true }` and once with
`{ fold: false }`, and requires the two to agree byte for byte. Its corpus is chant's own shipped
examples, which are written to demonstrate features and are therefore all happy-path. The agreement
claim was only ever tested on source that had no reason to break it (chant #2347).

This entry is the source that has a reason. Every file in `src/` targets exactly one
**resolution-time** decision point — a place where the shape classifier (`packages/core/src/fold/subset.ts`)
cannot tell what will happen, because what happens depends on what a name resolves to or what a
value turns out to be — and is named for it. The list comes from two enumerated sources, in order:
the environment-dependent divergences `subset.ts`'s own module doc lists, then the behavioural
`GAP (new)` rows in INTENTIUS/typescript-as-data's `spec/inventory.md`. Row identifiers below are
that inventory's.

| File | Decision point | Fold decision | What agreement means here |
|---|---|---|---|
| `nullish-property-read.ts` | L3.10 `F-Div-Nullish` — property read on a nullish object (#2328) | run | error parity: both paths report the same `TypeError` |
| `optional-chain-short-circuit.ts` | L3.21 — `?.` on nullish, and the short-circuit through the rest of the chain | fold | byte-identical output |
| `helper-name-shadowed.ts` | L5.3 `F-Eval-Ident` — a local `const` defeats a registered helper or intrinsic name | fold | byte-identical output |
| `spread-non-object.ts` | L3.4 `F-Div-SpreadType` — object spread of a non-object | run | byte-identical output; fold refuses rather than guessing |
| `function-call-depth-bound.ts` | L5.8 `F-Depth` — `MAX_FUNCTION_CALL_DEPTH = 32` | run | byte-identical output; a resource limit may not change what is built |
| `taint-run-only-importer.ts` | L5.4 `S-FnBody` — early return in a project-local function; the fixpoint's seed | run | — |
| `taint-shared-config.ts` | L8.6 `F-Succ` forward — an importer that runs pulls its imports back | run (taint) | — |
| `taint-capturing-sibling.ts` | L8.7 `F-Succ` backward — a captured object's source pulls the capturer back | run (taint) | — |
| `taint-independent.ts` | L8.8 `F-Taint`/`F-Fix` — no edge reaches it | fold | the control that makes the three rows above mean something |

The last four are the reason the entry is one directory rather than nine. `planFoldTaint`'s
bidirectional fixpoint only does anything across a fold/run boundary *inside a single build*, so a
fully-folding entry never exercises it and a mixed entry exercises it by accident at best. These
four make it fire in both directions on purpose, and `fold-adversarial.test.ts` asserts which file
each edge moved — a comparison of the entry's output alone cannot tell "three files fell back
because the taint said so" apart from "this entry does not fold".

## Running it

```
just fold-differential                                   # the gate: this entry among the rest
npx vitest run examples/fold-adversarial                  # the split, named file by file
```

## Why the build fails, and why that is pinned

`chant build .` on this directory reports one `DiscoveryError` and exits non-zero, for ever:
`nullish-property-read.ts` throws when it is imported, which is the whole point of the #2328
fixture. The root-examples build-and-lint gate (`examples/root-examples-gate.test.ts`) enumerates
this directory like any other and carries an `expected-failure` allowlist entry for it, so the
failure is asserted rather than tolerated — if the fixture ever stops failing, the gate says so.

`chant.config.ts` is here for a duller reason. `findProjectConfig`
(`packages/core/src/project-root.ts`) walks up from `src/` looking for a config or a project
boundary; with neither in this directory nor in `examples/`, it stops at the repo root's `.git`
and `chant lint src` lints the whole repository — 369,692ms against 51ms with the config present.
