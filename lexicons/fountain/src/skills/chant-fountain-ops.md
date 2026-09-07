---
skill: chant-fountain-ops
description: Declare a fountain steward, run a chant op on it, read its thread, and approve a gate
user-invocable: true
---

# Running chant ops on a fountain steward

A steward is an environment's one writer: a fountain `Agent` running `chant acp`
on a persistent sandbox, seated on the team as a `Teammate` so it has a standing
conversation. That conversation is the environment's operational history — each
turn is one chant command line.

Two stores, each authoritative for one thing. Runs live in fountain's database
as turns; facts that outlive a run (a gate's resolution) live on chant's ledger
branch in git. Nothing is stored twice.

## Declare a steward

```ts
import { ConvergeOp, WatchOp, gt, report, when } from "@intentius/chant/op";
import { Environment, Repository, Steward, Vault } from "@intentius/chant-lexicon-fountain";

export const toolchain = new Environment({
  name: "prod-toolchain",
  repositories: [new Repository({ url: "https://github.com/acme/estate", mount_path: "/workspace/estate", ref: "main" })],
  setup_script: "npm ci && npm install -g @intentius/chant",
  networking_type: "limited",                       // FTN010 requires explicit intent
  networking_config: { allowed_hosts: ["github.com", "registry.npmjs.org"] },
  metadata: { "managed-by": "chant" },
});

export const prodCreds = new Vault({ name: "prod-creds", metadata: { "managed-by": "chant" } });

export const { op: prodWatch } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
export const { op: prodConverge } = ConvergeOp({
  name: "prod-converge",
  env: "prod",
  dial: "observe",
  schedule: "0 * * * *",
  rules: [
    when(gt("updateCount", 0), report("declared and live state disagree"), {
      id: "prod-drift",
      why: "Every rule carries its why — this one is required, not decoration.",
    }),
  ],
});

export const { agent, teammate, schedules } = Steward({
  name: "prod-steward",
  environment: toolchain,
  vault: prodCreds,                                 // omit under an egress broker
  ops: [prodWatch, prodConverge],
  webhook: { url: "https://hooks.example.com/chant" },   // optional, https only
});
```

`ops` accepts the `Op` declarations the composites return, or plain `OpConfig`
objects. The steward reads two fields off each: the name, which becomes the
prompt `chant run <op>`, and the schedule, which becomes the `Schedule`'s cron.
An op with no cadence gets no `Schedule` but is still listed, which is how
`chant run <op> --on fountain` finds the thread it belongs on.

Defaults worth knowing: `sandbox_mode: persistent` (the checkout survives a turn
ending), `permission_policy: { default: "auto_allow" }` (nobody is at the
keyboard; chant's gates are where a human belongs), no model, no skills, and
`allowed_vault_ids` scoped to the one vault it was given.

## Apply it

```bash
chant build                      # emits all six kinds in dependency order
chant run <apply op>             # or call fountainApply directly
```

`fountainApply` sends Environment, Vault and Agent through fountain's bulk
`POST /api/apply`, then Teammate, Schedule and Webhook through their own routes,
matched by name and by url. A second apply of an unchanged manifest writes
nothing.

Endpoint and token come from `fountain.profiles` in `chant.config.ts`, falling
back to `FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN`. A profile's `token` is always
`{ env: "VAR" }`; FTN001 refuses a literal.

## Run an op on it

```bash
chant run prod-watch --on fountain
chant run prod-watch --on fountain --profile staging
```

The thread is resolved in this order: a declared `Steward` listing the op, then
the profile's `team`, then `--param agent=<name>`, then the op's `labels.Agent`.
The first two post to the teammate's own thread; the last two open a fresh
conversation instead.

Read it back:

```bash
chant run status prod-watch --on fountain
chant run log prod-watch --on fountain
chant run list --on fountain
chant run cancel prod-watch --on fountain --force
```

`cancel --force` terminates the conversation and takes the persistent sandbox
with it; without `--force` the provider only interrupts the turn. `chant run
cancel` requires `--force`, so reach for the provider directly if you want the
cheaper one.

## Approve a gate

A run that reaches an unapproved gate ends its turn with the pending fact and
the approve line. Resolve it on chant's ledger, then wake the thread:

```bash
chant approve prod-apply deploy-window --approver alice
chant run approve prod-apply deploy-window --on fountain
```

The second posts `chant run <op>` back onto the steward's thread, with
`--approver` and `--url` on it, so the sandbox re-runs the op and reads the
now-resolved fact.

`--durable-requests` (answering fountain's own permission card instead) is
refused by name: it needs BinaryBourbon/fountain#1635, which has not shipped.

## When the steward is busy

A teammate runs one turn at a time. A post to a busy one comes back
`400 conversation_busy`, and the runtime reports it with the conversation's URL
and does not retry:

```
fountain runtime: the steward "prod-steward" is running another op
(https://…/conversations/c_01J…). A teammate runs one turn at a time; wait for
it to finish and run this again.
```

Do not paper over this with a retry loop. Open the conversation, see which op is
running, and re-run when it settles. The same rule is why a `Schedule` that
fires mid-turn is dropped rather than queued, and why `Steward` refuses any op
whose `schedule.overlap` is not `"skip"`.

Two stewards on one environment and vault are refused at construction for the
same reason: that is two processes on one checkout, and their turns would
interleave.

## Patience

fountain closes an idle event-stream connection after 60 seconds. A quiet turn
therefore loses its connection and the reader reconnects with `Last-Event-ID`.
Only real silence ends the wait, after `FOUNTAIN_STREAM_IDLE_TIMEOUT` seconds
(default 1800), and it ends with an error naming the conversation rather than a
success nobody saw.

## Two upstream caveats

- `runtime: "acp"` with `runtime_command` is BinaryBourbon/fountain#1634 and is
  not in v0.16.0. An instance without it rejects the pair at apply.
- Bulk apply covering the team-side kinds is BinaryBourbon/fountain#1636. Until
  then they go through their own routes, which is what `fountainApply` does.
