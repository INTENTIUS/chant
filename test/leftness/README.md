# Left-of-line proof harness (#1084)

chant's epic #1019 claims the tool is left of the line by construction: it knows a
project's resource graph before executing any of the project's code. This directory makes
that a measurement instead of a sentence — one procedure, run identically against a tool
that structurally cannot pass it.

## The matched pair

The same infrastructure, expressed twice: a CRUD items API (DynamoDB table, Lambda
handler, HTTP API with four routes, and the IAM the wiring implies). The shape is the
canonical CDK CRUD example, sized big enough to be honest and small enough to audit.

- `chant-app/` — chant declarables against pinned published packages. Declares explicitly
  what CDK implies (the execution role's policy, the API's invoke permission).
- `cdk-app/` — plain-JavaScript CDK app, deliberately: no ts-node or bundler frames muddy
  the capture. `cdk.json` profiles the **app subprocess**, not the CLI — `cdk synth`
  spawns the app, so profiling the CLI would measure the wrong process, and the app-only
  capture is the version CDK has no grounds to object to.

`parity.mjs` holds the pair together: identical resource surface, with exactly two
documented expansion-style deltas (CDK's separate `IAM::Policy`; CDK's per-route
`Lambda::Permission` × 4 vs one wildcard permission), both of which make the CDK template
larger, never the reverse. Any other drift fails the run.

## The measurement

`./capture.sh` (or `just leftness-capture` from the repo root) installs both estates from
committed lockfiles, profiles both synths with `node --cpu-prof`, and applies one
analyzer to both captures. No cloud credentials; both synths are offline. Timing is
deliberately absent from every output — this is not a benchmark, and if it ever reports
which tool is faster the metric has drifted (#1084's non-goal).

Two numbers per tool, boundary definitions in `analyze.mjs`'s header:

1. **Project-code boolean** — did any frame from the estate's own source files execute?
   A cpuprofile cannot say what fraction of the graph was known at time T (the original
   AC asked for a measurement a capture cannot carry), so the headline is the boolean,
   which is the strong claim anyway. Sampling can miss frames but never invent them, so
   the CDK side's `true` is definitive; the chant side's `false` is additionally pinned
   by an unsampled invariant — the run fails unless every file reports `[fold:fold]`,
   zero module execution, enforced by the build itself.
2. **Trusted-computing-base bytes** — distinct third-party files observed executing,
   byte-sized on disk. Each estate's `package.json` declares exactly one kind of
   dependency, so the role split (synthesizer vs definition library) falls out of the
   manifest, not a curated list. Both tools execute machinery; only one must execute the
   project's definition graph to know what it builds.

## Current committed result

| measurement | chant build --fold | cdk synth (app) |
| --- | --- | --- |
| project code executed | **false** | **true** |
| definition-library TCB | 0 MB | ~1.7 MB |
| synthesizer TCB | ~10.8 MB | 0 MB (CLI not in the app capture) |

`captures/` holds the raw `.cpuprofile`s (path prefixes sanitized to `/leftness` so the
files are machine-independent; regenerating rewrites them). `results/` holds the analyzer
and parity outputs.

## Exhibits

`exhibits/render.mjs` turns both captures into static timeline SVGs via spicypath's
headless renderers (package-attributed colors, search-dim on the estate's own files, a
derived marker at the first project frame):

```
node exhibits/render.mjs /path/to/spicypath
```

The CDK exhibit carries a "first project frame" marker near t=0. The chant exhibit has no
project frame to mark, and its title says `0 project fns matched` — a busy timeline (the
TypeScript parser is real work) with an empty highlight. That asymmetry is the argument,
rendered.

## Reproducing

Everything regenerates from committed inputs: pinned exact versions in both estates'
`package.json` + committed lockfiles, `capture.sh` end to end. Machine-local absolute
paths never survive into the committed captures. Sampling profiles vary run to run in
which frames they catch; neither reported number depends on sample timing.
