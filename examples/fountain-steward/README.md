# fountain steward

One writer for the `prod` environment, declared. This is the hosted-runtime
example: `chant run <op> --on fountain` hands a run to a fountain teammate
instead of executing it here, and that teammate's thread becomes the
environment's operational history.

Five declarations produce six fountain resources:

| File | Declares |
|---|---|
| `src/fountain.ts` | the toolchain `Environment`, the `Vault`, and the `Steward` that binds the ops to a teammate |
| `src/prod-watch.op.ts` | a `WatchOp` on a fifteen-minute cadence |
| `src/prod-converge.op.ts` | a `ConvergeOp` on an hourly cadence, observe dial |
| `src/steward-apply.op.ts` | a gated apply, no cadence: it runs when someone asks |
| `chant.config.ts` | `fountain.profiles.prod`, and the `repoUrl` build parameter |

`chant init --lexicon fountain --template steward` scaffolds the same shape
without the gated apply.

## 1. Build

```bash
npm install
npm run build          # dist/fountain.yaml
```

Six documents come out, in dependency order: `Environment`, `Vault`, `Agent`,
`Teammate`, and one `Schedule` per op that carries a cadence. `steward-apply`
has no cadence, so it gets no `Schedule`; it is still listed on the steward,
which is what tells a run of it which thread it belongs on.

The agent is the interesting one:

```yaml
kind: Agent
metadata:
  name: prod-steward
spec:
  runtime: acp
  runtime_command: chant acp
  sandbox_mode: persistent
  environment: prod-toolchain
  permission_policy:
    default: auto_allow
  allowed_vault_ids:
    - prod-creds
```

The sandbox runs chant's own ACP server, so a prompt on that thread is a chant
command line. `sandbox_mode: persistent` means the checkout and the tool cache
survive a turn ending, which is what makes it one computer rather than one per
run.

Point it at your own estate with the build parameter:

```bash
npx chant build src --lexicon fountain -o dist/fountain.yaml \
  --param repoUrl=https://github.com/you/your-estate
```

## 2. Apply

```bash
export FOUNTAIN_TOKEN=...          # the variable chant.config.ts names
npx chant lint src                 # FTN010, FTN016, FTN020..FTN023
node -e "import('@intentius/chant-lexicon-fountain').then(m => m.fountainApply({ manifestPath: 'dist/fountain.yaml', profile: 'prod' }))"
```

`fountainApply` sends `Environment`, `Vault` and `Agent` through fountain's
bulk `POST /api/apply`, then reconciles `Teammate` and the two `Schedule`s
through their own routes, matched by name. A second apply of an unchanged
manifest makes no writes.

`runtime: "acp"` with `runtime_command` is
[fountain#1634](https://github.com/BinaryBourbon/fountain/pull/1634) and is not
in v0.16.0. An instance without that PR rejects the pair here.

## 3. Run an op on the steward

```bash
npx chant run prod-watch --on fountain
```

The command line `chant run prod-watch` is posted to the steward's thread, the
CLI tails the conversation's event stream, and the run's record comes back in
the same shape a local run would have written. Compare with the local path,
which needs no fountain at all:

```bash
npx chant run prod-watch
```

If the steward is mid-turn the post is refused rather than queued:

```
fountain runtime: the steward "prod-steward" is running another op
(https://fountain.inevitable.fyi/conversations/c_01J…). A teammate runs one
turn at a time; wait for it to finish and run this again.
```

That refusal is fountain's single-writer rule, and it is the point: two runs on
one checkout would interleave. The same rule is why the `Schedule`s are
in-thread, so a cron fire that lands mid-turn is dropped rather than opening a
second machine beside the first.

## 4. Read the thread

```bash
npx chant run status prod-watch --on fountain    # the latest turn
npx chant run log prod-watch --on fountain       # every turn that ran this op
npx chant run list --on fountain                 # one row per declared Op
```

Or open the conversation in fountain's UI. Each turn is one command someone
could have typed, so scrolling it is scrolling what was done to `prod`. The
steps of a `chant run` turn arrive as tool calls, one per declared step, so the
whole plan renders before the first one finishes.

## 5. Approve the gated apply

```bash
npx chant run steward-apply --on fountain
```

The run builds, reaches the gate, and ends its turn with the approve line. The
gate is a fact on chant's ledger, not a wait held open inside the sandbox:
nothing is blocked and no machine is pinned by a decision nobody has made yet.

```bash
npx chant approve steward-apply approve-steward-apply --approver you
npx chant run approve steward-apply approve-steward-apply --on fountain
```

The first records the resolution on the ledger branch. The second posts
`chant run approve …` back onto the steward's thread, so the sandbox re-runs
the op and walks through the now-resolved gate.

`--durable-requests`, which would answer fountain's own permission card
instead, is refused by name: it needs
[fountain#1635](https://github.com/BinaryBourbon/fountain/issues/1635), which
has not shipped.

## What CI covers

`examples/examples.test.ts` builds and lints this example on every change and
asserts the six kinds, the ACP agent fields and both schedule prompts. The
live half — a real fountain instance, an apply, a turn on a real thread — is
this README's walkthrough and is not run in CI.

## Further reading

- [The Steward](/chant/lexicons/fountain/steward/)
- [Running an Op on fountain](/chant/lexicons/fountain/runtime/)
- [chant acp](/chant/lexicons/fountain/acp/)
