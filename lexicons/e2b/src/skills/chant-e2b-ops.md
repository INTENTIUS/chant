---
skill: chant-e2b-ops
description: Run chant ops on a steward sandbox with `--on e2b`, on hosted E2B or any API that speaks E2B's
user-invocable: true
---

# Running chant ops on an e2b steward

`chant run <op> --on e2b` runs the op on a steward: one sandbox that outlives
every run. It keeps a clone of the project and its installed tools on its disk,
runs one op at a time, and sleeps paused between runs. Any API that speaks
E2B's hosts one: hosted E2B, or a platform that serves the same API.

## Set it up

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
        domain: "e2b.example.com",        // omit for hosted E2B
        steward: "prod-steward",           // default: the repository's name
        gitToken: { env: "GITHUB_TOKEN" }, // fetch a private repo, push the ledger
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
```

The project must depend on `@intentius/chant`, because the steward runs the
chant the project installs. The template (default `base`) needs git and Node.

## Run, read, cancel

```bash
chant run prod-apply --on e2b              # streams the steps, then pauses the steward
chant run status prod-apply --on e2b       # a run in progress, or the last one recorded
chant run log prod-apply --on e2b
chant run cancel prod-apply --on e2b --force
```

The steward runs the commit this checkout is at, fetched from the repository,
so **push first**. Uncommitted changes are not sent; the run warns about them.

One run at a time: a run while the steward is busy is refused, naming the run
in progress. A client that dies mid-run (Ctrl-C excepted) leaves the run going;
`status` reports it, and the steward pauses itself when it is done.

## Gates

A gate works as it does locally. The run reaches it in the sandbox, pushes the
pending fact to the repository's `chant/lifecycle` branch and ends `gated`
(exit 3). `chant approve <op> <gate>` from any checkout of the repository
records the answer, and the next `--on e2b` run walks through. The steward also
pushes its run records, so `chant run log` on any checkout sees its runs.

## Running on a schedule

Nothing in E2B fires on a clock. Run `chant run <op> --on e2b` from whatever
already does: a CI `schedule:` trigger (the github lexicon renders an op's
`schedule` as one), a CronJob, or `chant operator` on a machine that stays up.
The job is short, because the steward does the work.
