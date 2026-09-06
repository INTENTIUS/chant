# fly-durable-deploy

A Fly Machines deploy that keeps running without anybody minding it. The op is
scheduled on a fountain steward: one teammate, one persistent machine, one
thread carrying every deploy this app has had.

Where [`fly-deploy-rollback`](../fly-deploy-rollback) uses a Sprite checkpoint as
its recovery boundary, durability here comes from two properties that have
nothing to do with a workflow engine.

**The machine persists.** The steward's sandbox is `sandbox_mode: persistent`,
so the checkout, the npm cache and the installed chant survive a turn ending.
A turn is a command on a computer that was already there, not a container
booted to run one deploy and thrown away.

**The op converges.** Build serializes `src/infra.ts` to the flaps plan; Deploy
applies that plan to the Machines API and waits each machine to `started`.
Applying it twice reaches the same App and the same Machine. So a turn that
dies halfway leaves the estate wherever it got to, and the next run — the
half-hourly fire, or one somebody types — walks the same steps against that
state and finishes. Nothing is resumed, because a convergent op has the same
shape from every starting point.

| File | Declares |
|---|---|
| `src/infra.ts` | the `App` and the `Machine` |
| `ops/fountain.ts` | the toolchain `Environment`, the `Vault`, and the `Steward` |
| `ops/fly-durable-deploy.op.ts` | the two-phase deploy and its `*/30 * * * *` cadence |
| `chant.config.ts` | `fountain.profiles.demo`, and the `repoUrl` build parameter |

## Run it locally

The op runs here, in-process, with no fountain at all — same steps, one
observation instead of a cadence:

```bash
docker run -d --rm -p 4280:4280 --name mudflaps ghcr.io/intentius/mudflaps:0.4.1

npm install
export FLY_FLAPS_BASE_URL=http://localhost:4280

chant run fly-durable-deploy       # its Build phase runs build:fly, then applies

chant run fly-durable-deploy       # again: the same App, the same Machine

docker rm -f mudflaps              # stop the emulator when done
```

The second run is the point. It reports the same steps and leaves the estate
where the first one left it — that is the property the schedule leans on.

## Run it on the steward

```bash
npm run build:fountain             # dist/fountain.yaml
export FOUNTAIN_TOKEN=...          # the variable chant.config.ts names
npm run lint
chant run fly-durable-deploy --on fountain
```

Four documents come out of `ops/fountain.ts`: the `Environment` the sandbox is
provisioned from, the `Vault` that holds `FLY_API_TOKEN`, the `Agent` that
speaks ACP over `chant acp`, and the `Teammate` seat that owns the thread —
plus one `Schedule`, because the op carries a cron. `chant run … --on fountain`
posts the command line to that thread and tails the turn; the record that comes
back has the shape a local run would have written.

If the steward is mid-turn the post is refused rather than queued. A teammate
runs one turn at a time, which is what keeps two deploys off one checkout, and
is also why the schedule is in-thread: a fire that lands mid-turn is dropped,
and the next one re-applies everything anyway.

Point the sandbox at your own estate with the build parameter:

```bash
chant build ops --lexicon fountain -o dist/fountain.yaml \
  --param repoUrl=https://github.com/you/your-estate
```

[`fountain-steward`](../fountain-steward/) is the fuller worked example of the
same shape: a watch, a converge and a gated apply on one thread.

## Real Fly

Drop the endpoint override and put a token in the vault — the same op:

```bash
unset FLY_FLAPS_BASE_URL
export FLY_API_TOKEN=...
chant run fly-durable-deploy
```
