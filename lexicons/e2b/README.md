# @intentius/chant-lexicon-e2b

Run chant Ops on a steward: one [E2B](https://e2b.dev) sandbox that outlives
every run. `chant run <op> --on e2b` hands the run to it.

The steward keeps a clone of the project and its installed tools on its disk,
runs one Op at a time, and sleeps paused between runs, which costs nothing and
survives anything short of deleting it. Any API that speaks E2B's can host it:
hosted E2B, or a platform of your own that serves the same API.

It gives an Op what [Ops as teammates](https://intentius.io/chant/concepts/durable-workflows/)
calls *the machine*: something that runs when nobody's laptop is open, without
holding one open between runs.

## Install

```bash
npm install --save-dev @intentius/chant-lexicon-e2b
```

```ts
// chant.config.ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-e2b";

export default {
  lexicons: ["e2b"],
  e2b: {
    profiles: {
      prod: {
        apiKey: { env: "E2B_API_KEY" },
        domain: "e2b.example.com",
        steward: "prod-steward",
        gitToken: { env: "GITHUB_TOKEN" },
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
```

| Field | Default | |
|---|---|---|
| `apiKey` | `{ env: "E2B_API_KEY" }` | The E2B API key, by environment variable. |
| `domain` | `E2B_DOMAIN`, else hosted E2B | The domain the SDK talks to. |
| `template` | `base` | The template the steward is made from. It needs git and Node. |
| `steward` | the repository's name | The steward's sandbox is found again by its `chant/steward` metadata. |
| `repo` | `origin`, as https | The repository the steward clones. An ssh `origin` is rewritten to https. |
| `gitToken` | `CHANT_GIT_TOKEN`, when set | A token to fetch a private repository and push chant's ledger branch. It is handed to each command in the sandbox and never written to its disk. |

With no profile, the runtime reads `E2B_API_KEY`, `E2B_DOMAIN` and
`CHANT_GIT_TOKEN`. `--profile <name>` picks another profile for one run.

The project must depend on `@intentius/chant`: the steward runs the chant the
project installs.

## The steward's template

A steward's sandbox is made from the profile's `template`, which is E2B's
`base` when the profile names none. Declare a `Template` and name it in the
profile when the project's Ops need tools that `base` lacks:

```ts
// src/steward.ts
import { Template } from "@intentius/chant-lexicon-e2b";

const steward = new Template({
  name: "chant-steward",
  fromImage: "node:22-bookworm",
  run: ["apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*"],
  cpuCount: 2,
  memoryMB: 2048,
});

export { steward };
```

`chant build` writes it as `e2b.chant-steward.Dockerfile` and
`e2b.chant-steward.toml`; build those once with
`e2b template build --config e2b.chant-steward.toml`. A steward that already
exists keeps its sandbox until it is deleted.

Two lint rules check a template's sizes and that its base image is pinned
(E2B001, E2B002). Three post-synth checks catch an Alpine base image, a name
E2B refuses or two templates sharing one, and a template with no visible git
or Node (E2B010 to E2B012). The [docs](https://intentius.io/chant/lexicons/e2b/)
cover each property and rule.

## What a run does

1. Finds the steward's sandbox, or makes it. A steward already running an Op is
   busy, and the run is refused rather than queued.
2. Fetches the repository in the steward's clone, checks out the commit this
   checkout is at (so push it first; uncommitted changes don't travel, and the
   run says so), and runs `npm ci` when the lockfile changed. Ignored files,
   `node_modules` among them, are kept between runs.
3. Runs `chant run <op> --on local --json --progress-json` there, streaming each
   settled step back.
4. Pushes the steward's ledger and pauses the sandbox.

Gates, leases and the run ledger are the local runtime's, unchanged. A gate the
steward reaches pushes its pending fact to the repository's `chant/lifecycle`
branch; `chant approve` on any checkout records the answer; the next run walks
through.

```bash
chant run prod-apply --on e2b              # exit 3: pending on rollout-gate
chant approve prod-apply rollout-gate      # from any checkout
chant run prod-apply --on e2b              # walks through, applies
chant run status prod-apply --on e2b       # a run in progress, or the last one recorded
chant run log prod-apply --on e2b
chant run cancel prod-apply --on e2b --force
```

A client that dies mid-run leaves the run going in the sandbox. `status`
reports it, and the steward pauses itself when its awake window (30 minutes,
renewed while a client is watching) runs out. Ctrl-C, or `chant run cancel`
from any checkout, stops it the way Ctrl-C stops a local run: SIGTERM, then
SIGKILL after ten seconds.

## The steward's ledger

chant pushes the facts other checkouts need as it writes them (a gate's pending
fact, an approval, a lease), but keeps run records on the local branch. A
checkout that lives on, as a steward's does, would then diverge from the
repository the first time someone approved a gate elsewhere, and chant refuses
to read a diverged ledger. So before and after each run the steward reconciles
its `chant/lifecycle` with the repository's: it pushes when it is only ahead,
and when the two have diverged it merges them (each `.jsonl` file is
append-only, so the merge adds the lines one side lacks) and pushes the merge.
Its run records therefore reach the repository, and `chant run log` on any
checkout sees them.

## Schedules

Nothing in E2B fires on a clock. Run `chant run <op> --on e2b` from whatever
does: a CI `schedule:` trigger (the github lexicon renders an Op's `schedule`
as one), a CronJob, or `chant operator` on a machine that stays up. The job is
short, because the steward does the work.

## Limits

- Workspace members: `status`, `log` and `list` read the root project's run
  ledger only.
- `declareSteward`'s forms are `local` and `fountain`; there is no `e2b` form
  yet, so a steward's schedules don't render to anything here. Drive them from
  a clock as above.
