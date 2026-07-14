import { App, Machine, Volume, MachineConfig, MachineGuest, MachineMount, Fly } from "@intentius/chant-lexicon-fly";

// A small multi-resource Fly stack: one app, a persistent volume, and two
// machines — `web` (which mounts the volume) and `worker`. It exists to show the
// reconcile flyApply does — create → no-op re-apply → in-place update →
// owned-only prune. The serializer stamps `managed-by: chant` into each
// machine's `config.metadata`, the ownership marker the prune reads back.
//
// `org_slug` is required by the Machines API. `Fly.OrgSlug` resolves from
// `FLY_ORG` at build time, defaulting to `personal` offline.
const app = new App({ name: "fly-reconcile-demo", org_slug: Fly.OrgSlug });

// A persistent volume. flyApply creates it before any machine that mounts it —
// the dependency order is on the wire (the volume is POSTed first).
const data = new Volume({ name: "data", region: "iad", size_gb: 1 });

const guest = new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });

const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest,
    // The mount references the declared volume by name (FLY011 checks this).
    mounts: [new MachineMount({ volume: "data", path: "/data" })],
  }),
});

const worker = new Machine({
  name: "worker",
  region: "iad",
  config: new MachineConfig({ image: "flyio/hellofly:latest", guest }),
});

export { app, data, web, worker };
