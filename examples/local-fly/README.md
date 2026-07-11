# local-fly

One Fly **app + machine**, deployed end-to-end on a **local emulator** with no
Fly account, no credentials, and no cost. The same op, minus the endpoint
override, deploys to a real Fly org.

| Resource | Synthesizes to | Applied by | Emulator |
|----------|----------------|------------|----------|
| App + Machine | flaps create bodies (JSON) | `flyApply` (direct Machines API) | mudflaps (`:4280`) |

Fly's control plane is the Machines API ("flaps"). There is no server-side
declarative apply and no state file, so `flyApply` (#739) does the reconcile
itself: GET-then-create per resource, then poll `/wait` until each machine
reaches `started`. It speaks the flaps REST API directly — no `flyctl`, no
shell-out. The local target is `mudflaps`, a stateful fake of the same API, so
the applier is exercised against a real flaps-shaped control plane offline.

## Run it

Requires only Docker. `chant run fly` runs the Op in-process (no Temporal
server) through five modeled phases:

```bash
npm install

chant run fly
```

```
[phase] Emulator
  ✓ flapsUp                       boots ghcr.io/intentius/mudflaps:0.3.0 on :4280
[phase] Build
  ✓ chantBuild(script=build:fly)  writes dist/fly.json
[phase] Apply
  ✓ flyApply(planPath=dist/fly.json)   created app + machine, waited to started
[phase] Verify
  ✓ httpCheck(.../machines)       machine reached started
[phase] Teardown
  ✓ flapsDown                     removes the mudflaps container
```

Every phase is a modeled activity (`flapsUp` / `flyApply` / `httpCheck` /
`flapsDown`), not a shell script. The `flapsUp` / `flapsDown` lifecycle is the
one step that shells out to Docker (`docker run` / `docker rm`), which is why
Docker is the sole prerequisite.

Machine-readable output for CI and scripting:

```bash
chant run fly --json
```

### What the loop proves

- **Re-apply is a no-op.** A second `chant run fly` finds the machine unchanged
  (same config) and skips it — `flyApply` compares the desired `config` against
  the live machine.
- **An image change updates in place.** Edit `config.image` in `src/infra.ts`,
  re-run, and `flyApply` leases the machine, updates it, and waits the new
  `instance_id` to `started`.
- **Removing the machine prunes it.** Delete the `web` machine, re-run with
  prune on (`flyDeploy({ app: "local-fly-demo", prune: true })`), and the
  owned-only prune destroys it — it carries the `managed-by: chant` marker the
  serializer stamped.

## The op

`ops/fly.op.ts` is one line — the `flyDeploy` composite from the fly lexicon:

```ts
import { flyDeploy } from "@intentius/chant-lexicon-fly";

export default flyDeploy({ app: "local-fly-demo" });
```

`flyDeploy` lays out the `Emulator → Build → Apply → Verify → Teardown` phases
and wires each to the fly activities. The Apply step's flaps endpoint defaults
to local mudflaps (`http://localhost:4280`).

## Real Fly

The same op deploys to a real Fly org with one change: drop the local endpoint
override and give it a token.

```ts
export default flyDeploy({ app: "local-fly-demo", endpoint: null });
```

```bash
export FLY_API_TOKEN=...   # a Fly deploy token
chant run fly
```

Passing `endpoint: null` drops the local override, so `flyApply` falls through
to `FLY_FLAPS_BASE_URL` (or Fly's default `https://api.machines.dev`) and sends
`Authorization: Bearer $FLY_API_TOKEN`. The local emulator is just an endpoint
swap; mudflaps accepts unauthenticated calls, real Fly needs the token. (The
Verify step is skipped against real Fly — a bearer-authenticated GET is outside
`httpCheck`'s reach — so the Apply step's own `/wait` on `started` is the
verification there.)
