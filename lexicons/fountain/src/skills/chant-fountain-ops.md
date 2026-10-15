---
skill: chant-fountain-ops
description: Declare a fountain steward, run a chant op on it, read its conversation, and approve a gate
user-invocable: true
---

# Running chant ops on a fountain steward

A steward is an environment's one writer: a fountain `Agent` running `chant acp`,
and one long-lived conversation of it, resumed by `channel_id`
`chant:steward:<name>`. Its sandbox keeps its disk across park and wake. That
conversation is the environment's operational history — each turn is one chant
command line.

Managoat removed persistent sandboxes, the team, its scheduler and webhooks
(managoat/managoat#2793). Do not declare a `Teammate`, `Schedule` or `Webhook`,
or `sandbox_mode: "persistent"`: each fails the build with FTN025.

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

export const { agent, declaration } = Steward({
  name: "prod-steward",
  environment: toolchain,
  vault: prodCreds,                                 // omit under an egress broker
  ops: [prodWatch, prodConverge],
});
```

`ops` accepts the `Op` declarations the composites return, or plain `OpConfig`
objects. Every op is listed, which is how `chant run <op> --on fountain` finds
the conversation it belongs on. An op's `schedule` stays on `declaration`;
Managoat has no scheduler, so fire it from a clock outside it — a CI
`schedule:` or a CronJob running `chant run <op> --on fountain`.

Defaults worth knowing: no `sandbox_mode` (every conversation gets a sandbox of
its own), `permission_policy: { default: "auto_allow" }` (nobody is at the
keyboard; chant's gates are where a human belongs), no model, no skills, and
`allowed_vault_ids` scoped to the one vault it was given.

## Apply it

```bash
chant build                      # emits Environment, Vault, Agent in dependency order
chant run <apply op>             # or call fountainApply directly
```

`fountainApply` sends them through Managoat's bulk `POST /api/apply`. Bulk
apply reports each resource as `created` or `updated` and nothing else, so it
never says a resource was already right. Nothing is applied for the steward's
conversation: the first `chant run <op> --on fountain` opens it.

Endpoint and token come from `fountain.profiles` in `chant.config.ts`, falling
back to `FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN`. A profile's `token` is always
`{ env: "VAR" }`; FTN001 refuses a literal.

## Run an op on it

```bash
chant run prod-watch --on fountain
chant run prod-watch --on fountain --profile staging
```

The conversation is resolved in this order: a declared `Steward` listing the op,
then the profile's `steward` (`team` is its deprecated alias), then
`--param agent=<name>`, then the op's `labels.Agent`. The first two open or
resume the steward's conversation (`POST /api/conversations` with `channel_id`
`chant:steward:<name>`); the last two open a fresh conversation instead.

Read it back:

```bash
chant run status prod-watch --on fountain
chant run log prod-watch --on fountain
chant run list --on fountain
chant run cancel prod-watch --on fountain --force
```

`cancel --force` terminates the conversation and takes its sandbox with it
(the next run opens a fresh one); without `--force` the provider only interrupts the turn. `chant run
cancel` requires `--force`, so reach for the provider directly if you want the
cheaper one.

## Approve a gate

A run that reaches an unapproved gate ends its turn with the pending fact and
the approve line. Resolve it on chant's ledger, then wake the conversation:

```bash
chant approve prod-apply deploy-window --approver alice
chant run approve prod-apply deploy-window --on fountain
```

The second posts `chant run <op>` back onto the steward's conversation, with
`--approver` and `--url` on it, so the sandbox re-runs the op and reads the
now-resolved fact.

`--durable-requests` (answering fountain's own permission card instead) is
refused by name: it needs fountain#1635's request-answer path, which fountain
carries and chant does not use yet (chant#2391).

## When the steward is busy

A conversation runs one turn at a time. A run posted while the steward's turn is
in flight is refused, and the runtime reports it with the conversation's URL and
does not retry:

```
fountain runtime: the steward "prod-steward" is running another op
(https://…/conversations/c_01J…). A steward runs one turn at a time; wait for
it to finish and run this again.
```

Do not paper over this with a retry loop. Open the conversation, see which op is
running, and re-run when it settles. A clock that fires mid-turn gets the same
refusal, which is the `"skip"` overlap a steward's declaration requires.

Two stewards on one environment and vault are refused at construction for the
same reason: that is two processes on one checkout, and their turns would
interleave.

## Patience

fountain closes an idle event-stream connection after 60 seconds. A quiet turn
therefore loses its connection and the reader reconnects with `Last-Event-ID`.
Only real silence ends the wait, after `FOUNTAIN_STREAM_IDLE_TIMEOUT` seconds
(default 1800), and it ends with an error naming the conversation rather than a
success nobody saw.

## Upstream caveat

- The lexicon is generated from Managoat v0.29.0. `runtime: "acp"` with
  `runtime_command` needs fountain v0.21.0 or later, and an instance older than
  v0.29.0 still has the team routes this lexicon no longer uses.
