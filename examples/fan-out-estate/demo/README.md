# The fan-out demo

A live demo of `examples/fan-out-estate`, titled "A broken stack shouldn't stall the whole rollout". It runs the example's pull-request pipeline on chant's own runner (`chant ci serve`), against a local Forgejo and floci, in a loop that a kiosk can show. The design is chant#4085, and the switch to chant's runner is chant#4100.

## The cycle

One cycle is two pull requests and a reset, in four chapters.

| Chapter | Steps | What happens |
|---|---|---|
| 1. The change goes out | pull-request, planned, waiting, approved, merged, applying | The author opens `demo/change-<n>`: network's topic gets `cycle <n>` in its display name, and cluster-a gains a FIFO queue without `.fifo`. pr-plan plans fifteen stacks in three waves. The reviewer approves the pull request and runs `chant approve`. The author merges. |
| 2. cluster-a breaks | failed | SQS refuses the queue name. pr-apply ends with eight applied, cluster-a failed and its six apps blocked. |
| 3. The fix | pull-request, planned, waiting, approved, merged, applying | The fix adds `.fifo`. Its plan and its apply reach cluster-a and app-01 to app-06 only. |
| 4. Done | applied, reset | All fifteen are in. The reset closes pull requests, forces main back to the base, deletes `chant/lifecycle` on the demo repo and applies the base again with `chant run --components all --env demo`, so the next cycle fails the same way. |

The driver never reads the runner's status or logs. It waits on chant's own reports under the runner's `--report-url`, `s3://chant-demo/fan-out-estate/reports/<pr>/<commit>/pr-plan.json` and `pr-apply.json`, and reads the failure from `pr-apply.json`'s `members[].status`. The runner also keeps its run index (`ci-run-index/v1`) under the same URL, at `runs/index.json`, with one entry per job it ran; the driver does not read it.

At every step it writes `demo-step/v1` (see `schemas/`) to `s3://chant-demo/fan-out-estate/step.json`, validated first. At a full cycle's reset it publishes `demo-cycle/v1` to `cycles/latest.json` and `cycles/<cycle>.json`, keeping the newest five. Each step has a time limit (`LIMITS` in `steps.ts`); past it the driver writes `stalled`, resets, and goes on, and a stalled cycle is never published.

## Running it

It needs Docker. Run `up` once, then `cycle` or `loop`.

```bash
cd examples/fan-out-estate
npm run demo -- up       # build and start the stack, set up the runner, push the base and apply it
npm run demo -- cycle    # one cycle; exits 1 on a stall
npm run demo -- loop     # cycles until Ctrl-C
npm run demo -- reset    # back to the base
npm run demo -- down     # stop the stack and chant-runner (down --purge also removes the state)
```

`just fan-out-demo` runs one cycle the same way (`just fan-out-demo cmd=up` first). It is on demand only and is not a CI job.

Forgejo is on `http://localhost:3390` and floci on `http://localhost:4590` (`CHANT_FAN_OUT_DEMO_FORGEJO_PORT` and `CHANT_FAN_OUT_DEMO_FLOCI_PORT` move them). The driver keeps its state (passwords, tokens, the reviewer's key, the runner's secrets file and the base tree) in `CHANT_FAN_OUT_DEMO_STATE`, by default `~/.local/state/chant-fan-out-demo`, and refuses a state directory inside the chant checkout.

## The runner

`chant-runner` is a service in the stack, from the job image. It runs `chant ci serve --forge forgejo --repo chant-demo/fan-out-estate --env demo --branch main --author author --events-json --report-url s3://chant-demo/fan-out-estate/reports --pr-build-command 'npm run build' --image chant-fan-out-demo-job:local --secrets /run/chant/secrets.env --state /var/lib/chant-runner --once`, one pass every two seconds. These are the generated workflow's flags, so the plan and apply run the same commands and write the same report keys. `--image` names the job image, so the runner adds no setup line of its own.

It plans each new head of an open pull request by `author` and applies each new commit on main, each job in process, in a fresh git worktree of its clone in the state volume `chant-fan-out-demo-runner-state`. There is no docker socket in the stack. It reads Forgejo at `http://forgejo:3000` as the `chant-runner` user, whose token `up` mints. Its secrets file gives every job `AWS_ENDPOINT_URL=http://floci:4566` and floci's test credentials: `up` writes it in the state directory with mode 0600, and the runner copies it to a 0600 file of its own, since `ci serve` refuses one that other users can read.

The runner signs the runs it records with its runner key. `up` runs `chant ci serve --setup-key` in the runner's container, which makes the key in the state volume, and lists its public half in the base's `.chant/trust.json` with `chant workspace trust runner add chant-runner:fan-out-demo`, before it pushes the base. The demo owns its repo, so the entry goes in with the base rather than through `--setup-key --trust`'s branch for review. `ci serve` checks the key against `.chant/trust.json` on main before every pass.

The demo repo has no workflow file, and Forgejo Actions is off. The base leaves out `.forgejo/workflows/`, and the stack has no forgejo-runner. The example keeps its own generated `.forgejo/workflows/chant-pr.yml` and the test that regenerates it: that is still the path for anyone who runs the estate on Forgejo Actions without chant's runner.

A reset deletes `chant/lifecycle` on the demo repo. Between passes, when the repo has none, the runner drops its clone's copy too, so the next cycle's ledger starts from the forge's.

## Layout

| Path | What it is |
|---|---|
| `stack/` | A chant project on the docker lexicon. `npm run build` there writes `compose.yaml` (compose project `chant-fan-out-demo`: Forgejo, chant-runner and floci from `ghcr.io/lex00/floci` pinned by digest) and `Dockerfile.jobImage`, the job image `chant-fan-out-demo-job:local` with node, git, chant and its aws lexicon at one release, and a pinned AWS CLI v2. The runner runs in that image. |
| `overlays/change/`, `overlays/fix/` | The files each pull request copies over the base, with `@CYCLE@` filled in. |
| `steps.ts` | The title, the four chapters, the step labels, the about cards, the highlights, the holds and the limits. |
| `driver.ts` | The command line. It wires the real forge, bucket and chant into the cycle. |
| `lib/cycle.ts` | One cycle, against the forge, the bucket and chant as interfaces (`lib/ports.ts`). |
| `lib/forgejo.ts`, `lib/bucket.ts`, `lib/chant.ts` | The real ones: Forgejo's REST API and git, floci's S3, and the checkout's chant. |
| `lib/stack.ts` | `up` and `down`, the runner's secrets file, its key and the base. |
| `driver.test.ts` | One cycle in process, with fakes for all three. |
| `stack.test.ts` | The built compose file, and up's runner steps with fakes. |
| `schemas/` | `demo-step/v1` and `demo-cycle/v1`. |

## Who does what

The author pushes, opens and merges. The reviewer approves the pull request on Forgejo (`POST .../pulls/<n>/reviews` with `APPROVED`) and runs `chant approve pr-<n> pr-apply --plan <digest> --approver forgejo@forgejo:3000:reviewer --sign <key>` from a fresh clone of the demo repo, so the gate line on `chant/lifecycle` is the reviewer's. `up` lists the reviewer's key in the base's `.chant/allowed_signers` and the runner's in its `.chant/trust.json`. Every git command runs in a clone outside the chant checkout, and the driver refuses one that has no `.git` of its own, so nothing it does reaches the checkout's own `chant/lifecycle` or `.chant/allowed_signers`.
