# fountain steward

One writer for the `prod` environment, declared. This is the hosted-runtime
example: `chant run <op> --on fountain` hands a run to the steward's
conversation on Managoat instead of executing it here, and that one
long-lived conversation becomes the environment's operational history.

Five declarations produce three Managoat documents:

| File | Declares |
|---|---|
| `src/fountain.ts` | the toolchain `Environment`, the `Vault`, and the `Steward` that binds the ops to one agent |
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

Three documents come out, in dependency order: `Environment`, `Vault` and
`Agent`. The cadences stay on the Ops: Managoat has no scheduler, so a clock
outside it fires them (step 6). `steward-apply` has no cadence; it is still
listed on the steward, which is what tells a run of it which conversation it
belongs on.

The agent is the interesting one:

```yaml
kind: Agent
metadata:
  name: prod-steward
spec:
  runtime: acp
  runtime_command: chant acp --steward prod-steward
  environment: prod-toolchain
  permission_policy:
    default: auto_allow
  allowed_vault_ids:
    - prod-creds
```

The sandbox runs chant's own ACP server, so a prompt in that conversation is a
chant command line. There is no `sandbox_mode`: every Managoat conversation
gets a sandbox of its own. What makes it one computer rather than one per run
is that every run goes to the same conversation, resumed by its `channel_id`,
and a conversation's sandbox keeps its disk, the checkout and the tool cache,
across park and wake.

Point it at your own estate with the build parameter:

```bash
npx chant build src --lexicon fountain -o dist/fountain.yaml \
  --param repoUrl=https://github.com/you/your-estate
```

## 2. Apply

```bash
export FOUNTAIN_TOKEN=...          # the variable chant.config.ts names
npx chant lint src                 # FTN010, FTN016, FTN023..FTN025
node -e "import('@intentius/chant-lexicon-fountain').then(m => m.fountainApply({ manifestPath: 'dist/fountain.yaml', profile: 'prod' }))"
```

`fountainApply` sends `Environment`, `Vault` and `Agent` through Managoat's
bulk `POST /api/apply` in one request. Bulk apply reports `unchanged` for a
document that already matched, and chant records it.

The lexicon is generated from Managoat v0.29.0. `runtime: "acp"` and
`runtime_command` are in its spec from v0.21.0, and `model` is optional there.
An instance older than v0.21.0 rejects the steward's `Agent` on both `runtime`
and `model`: `{"runtime":["is invalid"],"model":["can't be blank"]}`.

## 3. Run an op on the steward

```bash
npx chant run prod-watch --on fountain
```

The command line `chant run prod-watch` is posted to the steward's
conversation (opened on the first run, resumed by `channel_id`
`chant:steward:prod-steward` after that), the CLI tails its event stream, and the run's record comes back in
the same shape a local run would have written. Compare with the local path,
which needs no fountain at all:

```bash
npx chant run prod-watch
```

If the steward is mid-turn the post is refused rather than queued. That
refusal is the single-writer rule, and it is the point: two runs on one
checkout would interleave. A clock that fires while a run is going gets the
same refusal, which is why a steward's Ops schedule with `overlap: "skip"`.

## 4. Read the conversation

```bash
npx chant run status prod-watch --on fountain    # the latest turn
npx chant run log prod-watch --on fountain       # every turn that ran this op
npx chant run list --on fountain                 # one row per declared Op
```

Or open the conversation in Managoat. Each turn is one command someone
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
`chant run approve …` back into the steward's conversation, so the sandbox re-runs
the op and walks through the now-resolved gate.

`--durable-requests`, which would answer fountain's own permission card
instead, is refused by name: it needs
[fountain#1635](https://github.com/BinaryBourbon/fountain/issues/1635), which
has not shipped.

## 6. Put the cadences on a clock

Managoat has no scheduler, so `prod-watch` (every fifteen minutes) and
`prod-converge` (hourly) fire from outside it. Any of these runs the same Op on
the same steward:

- A CI schedule, such as a GitHub Actions `schedule:` trigger, whose job runs
  `npx chant run prod-watch --on fountain`.
- A Kubernetes CronJob running the same command line.

`chant operator --steward prod-steward` runs a steward's Ops on their crons
too, but only in an environment whose form is `local`: it refuses one whose
form is `fountain`, since the steward's runs belong in its conversation there.
See [the operator guide](/chant/guide/operator/).

## Coming from Teammate, Schedule and Webhook

In earlier releases of the lexicon the Steward also declared a `Teammate`
seat, one `Schedule` per cadence and an optional `Webhook`, and its Agent ran
with `sandbox_mode: persistent`. Managoat removed all four;
[managoat/managoat#2793](https://github.com/managoat/managoat/issues/2793)
tracks bringing chant along.
The kinds are still exported, deprecated, so an old project builds far enough
to fail with FTN025, which names the replacement:

| Before | Now |
|---|---|
| `Teammate` seat and its `fountain:team` thread | One conversation per steward, resumed by `channel_id` `chant:steward:<name>`; `chant run --on fountain` opens and resumes it |
| `Schedule` per Op cadence | A clock outside Managoat: a CI schedule or a CronJob that runs `chant run <op> --on fountain`, or `chant operator --steward` in an environment whose form is `local` |
| `Webhook` | None. Read the outcome from `chant run status`, or from the conversation's event stream |
| `sandbox_mode: "persistent"` on the Agent | Nothing: drop it. The steward's conversation keeps its sandbox's disk across park and wake |
| `fountain.profiles.<name>.team` | `fountain.profiles.<name>.steward`; `team` still works and warns |
| `const { agent, teammate, schedules, webhook } = Steward(...)` | `const { agent, declaration } = Steward(...)` |

## What CI covers

`examples/examples.e2e.test.ts` builds and lints this example before every
release and asserts the three documents, `Environment`, `Vault` and `Agent`,
along with the ACP agent fields and the absence of `sandbox_mode`. The live
half, a real Managoat instance, an apply and a turn in a real conversation, is
this README's walkthrough and is not run in CI.

## Further reading

- [The Steward](/chant/lexicons/fountain/steward/)
- [Running an Op on fountain](/chant/lexicons/fountain/runtime/)
- [chant acp](/chant/lexicons/fountain/acp/)
