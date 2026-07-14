# fly-reconcile

One Fly **app + a volume + two machines** (`web` mounts the volume), reconciled
against a **running** mudflaps by `flyApply`. Where [`local-fly`](../local-fly)
boots and tears down the emulator each run, this example points at a persistent
mudflaps so you can run it repeatedly and watch the reconcile: create → no-op →
in-place update → owned-only prune. No `flyctl`, no state file.

| Resource | Serializes to | Applied by |
|----------|---------------|------------|
| App + Volume + 2 Machines | flaps create bodies (JSON) | `flyApply` (prune on) |

The op is `Build → Apply` only — it does not manage the emulator, so state
survives between runs. `flyApply` GET-then-creates each resource, updates changed
machines in place, and (with `prune: true`) destroys chant-owned machines no
longer declared. A machine created directly in mudflaps, without the
`managed-by: chant` marker, is left untouched.

## Run it

Boot mudflaps once, then run the op as many times as you like:

```bash
docker run -d --rm -p 4280:4280 --name mudflaps ghcr.io/intentius/mudflaps:0.4.1

npm install
chant run fly            # first run: creates app + volume + web + worker
chant run fly            # second run: no-op — nothing changed
```

Then exercise the reconcile:

- **Update in place.** Change `web`'s `config.image` in `src/infra.ts` and
  re-run — `flyApply` leases the machine, updates it, and waits `started`.
- **Owned-only prune.** Delete the `worker` machine and re-run — the prune
  destroys it, because it carries the `managed-by: chant` marker.
- **Foreign resources survive.** Create a machine directly in mudflaps
  (`curl -X POST .../machines`) and re-run — the prune leaves it alone; it has no
  ownership marker.

Stop the emulator when done:

```bash
docker rm -f mudflaps
```

## Real Fly

Drop the endpoint override and give it a token — the same op, no code change:

```ts
// ops/fly.op.ts
phase("Apply", [flyApplyStep("dist/fly.json", { prune: true })]),   // no endpoint
```

```bash
export FLY_API_TOKEN=...
chant run fly
```

With no `endpoint`, `flyApply` falls through to `FLY_FLAPS_BASE_URL` (or Fly's
`https://api.machines.dev`) and sends `Authorization: Bearer $FLY_API_TOKEN`.
