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

## Releases on a Machine

A component can deploy to Fly with this lexicon alone. It declares an `App` and the `Machine` that serves, builds them with `chant build --lexicon fly -o dist/fly.json`, and deploys with the `fly-release` step. Here a `Publish` phase (`publish-image`, elided) pushes the image, and the release serves it by digest:

```ts
import { phase, type Component } from "@intentius/chant/components";

export const web: Component = {
  name: "web",
  deploy: [
    phase("Publish", [/* publish-image */]),
    phase("Release", [
      {
        kind: "fly-release",
        plan: "dist/fly.json",
        digest: "@Publish.digest",
        image: "@Publish.uri",
        migrations: [{ name: "001_init.sql", command: "node migrate.js 001_init.sql" }],
        verify: { url: "https://web.example.com", healthPath: "/health" },
      },
    ]),
  ],
};
```

The step updates the Machine in place with the release in its `config.metadata`: `chant-release-digest`, `chant-release-git-sha` (the commit, `git rev-parse HEAD` unless given), and `chant-release-previous-digest` (the release it replaced). Each migration then runs inside the Machine through the Machines API's exec, once per environment: its receipt is kept on `chant/lifecycle` at `<env>/receipts/`, and a migration fires again only when its `sha` (or command) changes. After a migration fires, the Machine restarts, and the step checks that it is started with this release and, given a `url`, that its health endpoint answers with this commit or digest. If anything fails after the Machine changed, the step puts back the config the Machine served before (on a first release, it stops the Machine) and fails.

The step's output carries `uri` and `digest`, so `chant run --components web --env prod` records the release in the ledger. `chant components status prod --live` reads the Machine's metadata back and compares its digest with the ledger's: the row is `reconciled` when they agree and `drifted` when the Machine serves something the ledger does not name. The component joins the Machine by name: name the component after the Machine entity, or list it in `liveNames`.

Each release's Machine config is kept on `chant/lifecycle` at `<env>/fly/<app>/<machine>/<digest>.json`. `fly-rollback` puts back the config of the release the serving one replaced (or the digest given as `to`), checks it, and outputs that digest so the ledger records it again. `fly-release`'s own saga compensation does the same.

The steps are also Op activities, for an Op that composes them itself: `flyMachineRelease`, `flyMachineExec`, `flyMachineRestart`, `flyMachineStop`, `flyMachineVerify` and `flyMachineRestore`. Wrap a migration's `flyMachineExec` in `effect()` so it fires once.

### A source tree instead of an image

An app with no image of its own ships as its files on the declared runtime image. Give `fly-release` a `source` in place of `image`: an archive made by core's `sourceArchive` step (`git archive` of one directory of a commit, the same bytes for the same commit), the sha256 it must have, the directory it holds, where the files go (default `/srv/app`) and the command that starts the app there. The archive is read only once its bytes hash to that digest, before the Machine changes, so the Machine never gets a tree nobody approved. The files go into the Machine's config, up to 1 MiB base64. A larger app needs an image.

An Op runs the same steps with the `flyRelease` activity, which takes the environment it ships to as `environment` (`env` stays the Machine's env vars). A release Op gates on the plan core's `releasePlan` writes and records the release with `releaseRecord`:

```ts
import { Op, phase, gate, build, sourceArchive, releasePlan, releaseRecord } from "@intentius/chant/op";
import { flyRelease } from "@intentius/chant-lexicon-fly";

const archive = sourceArchive("../app", { id: "archive" });
const plan = releasePlan({ id: "plan", component: "app", env: "fly", gitSha: archive.out.commit, content: { artifact: { digest: archive.out.digest } } });

export default Op({
  name: "release",
  overview: "Ship the app member to Fly once its plan is approved",
  phases: [
    phase("Build", [archive, build(".", { script: "build:fly" })]),
    phase("Plan", [plan]),
    phase("Gate", [gate("ship", { plan: plan.out.digest })]),
    phase("Ship", [
      flyRelease({
        environment: "fly",
        plan: "dist/fly.json",
        digest: plan.out.digest,
        gitSha: archive.out.commit,
        source: { archive: archive.out.archive, digest: archive.out.digest, dir: archive.out.dir, start: "node server.js" },
      }),
    ]),
    phase("Record", [releaseRecord({ plan: plan.out.file, digest: plan.out.digest, approval: { op: "release", gate: "ship" } })]),
  ],
});
```

The Machine's metadata names the plan's digest, and so does the ledger record, so `chant components status fly --live` reconciles them. Running the Op again for the same commit plans the same digest, leaves the Machine as it is, and records nothing twice.
