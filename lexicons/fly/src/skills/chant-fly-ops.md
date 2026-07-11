---
skill: chant-fly-ops
description: Operate a live Fly deploy — wait on stuck machines, resolve lease conflicts, prune safely, and target a real org versus the emulator
user-invocable: true
---

# Fly Operations Playbook

This skill covers running `flyApply` against a live app: what the wait loop does, how leases resolve conflicts, when prune is safe, and how to point the same code at a real org or the mudflaps emulator. For authoring and the first deploy, see `chant-fly`; for the individual resource types, see `chant-fly-patterns`.

## Targeting real Fly or the emulator

The endpoint resolves in this order: an explicit `endpoint` arg, then `FLY_FLAPS_BASE_URL`, then the real-Fly default (`https://api.machines.dev`). The bearer token defaults to `FLY_API_TOKEN`.

| Target | How |
|--------|-----|
| Local mudflaps (offline, no account) | Leave `FLY_API_TOKEN` unset and point `FLY_FLAPS_BASE_URL` at the mudflaps host (the deploy Op does this for you against a local container) |
| Real Fly org | Set `FLY_API_TOKEN`, drop the local `FLY_FLAPS_BASE_URL` override |

The same plan applies to both. The only difference is the endpoint, so the loop you test offline is the loop you ship.

## Waiting for a machine to start

After a create or update, `flyApply` polls `GET .../wait` until the machine reaches `started` at its new `instance_id` (its config version). flaps caps its own long-poll at 60 seconds and answers 408 when that expires, so the client re-polls until an overall deadline (300 seconds by default). A destroy waits for `state=destroyed` the same way; a reaped machine satisfies that wait.

If a machine never reaches `started`:

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| Wait keeps re-polling, machine stays in `created` or `starting` | Image pull or boot is slow, or the guest sizing is under-provisioned | Check the image reference and the `MachineGuest` values; watch the machine on the target org |
| Wait fails with a non-408 status | flaps rejected the machine (bad config the build check did not catch, or an org-side limit) | Read the error body; fix the config and re-apply |
| Wait times out at the deadline | The machine cannot reach `started` in time | Inspect the machine directly on the org, then re-apply once the cause is fixed |

## Lease conflicts

Mutating an existing machine (update or destroy) is gated behind a Machines API lease. `flyApply` acquires a lease, echoes the nonce in the `fly-machine-lease-nonce` header on the mutation, and releases the lease afterward. A leaked lease expires on its own TTL, so release is best-effort.

Conflict handling is automatic: a 409 whose body mentions a lease is a stale or lost nonce, so the applier re-acquires a fresh lease and retries the mutation once. A 409 that is not lease-shaped (for example "app already exists") is not retried. If a mutation keeps failing on a lease conflict, another operator is holding the machine; wait for their lease to clear or coordinate before re-applying.

## Prune, and when it is safe

Prune is off by default and destructive. It removes resources the plan no longer declares.

- Machines are owned-only: a machine is pruned only if it carries the `managed-by: chant` marker. A foreign machine in the same app is never touched, so it is safe to run `flyApply` with prune against an app that also holds machines you manage elsewhere.
- Volumes, IPs, certificates, and secrets are app-scoped, because they have no marker channel. Under a chant-managed app, anything the plan no longer declares is removed, including a resource of those types created out of band. Before enabling prune on such an app, confirm every volume, IP, certificate, and secret in it is chant-declared, and keep prune to a single chant-declared app.

Each prune logs the resource and endpoint it removed, so a prune run is auditable from the Op output.

## Teardown

`flyDelete` is the inverse of `flyApply`: destroy the machines the plan declares (dependents first), then delete the apps. It is idempotent, so an already-absent machine or app is a no-op. The deploy Op's teardown phase uses this to tear the emulator's app down at the end of an offline loop.

## Re-applying is safe

A re-apply of an unchanged stack is a no-op per resource: machines whose config is structurally equal to live are skipped, volumes and certificates that already exist are skipped, and an IP of an already-present family is skipped. Only apply-only secrets are always re-set, because flaps exposes no value to diff against.
