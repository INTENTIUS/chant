import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

// A small multi-machine Fly stack: one app and two machines. It exists to show
// the reconcile flyApply does — create → no-op re-apply → in-place update →
// owned-only prune. The serializer stamps `managed-by: chant` into each
// machine's `config.metadata`, the ownership marker the prune reads back.
//
// `org_slug` is required by the Machines API. `Fly.OrgSlug` resolves from
// `FLY_ORG` at build time, defaulting to `personal` offline.
const app = new App({ name: "fly-reconcile-demo", org_slug: Fly.OrgSlug });

const guest = new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });

const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({ image: "flyio/hellofly:latest", guest }),
});

const worker = new Machine({
  name: "worker",
  region: "iad",
  config: new MachineConfig({ image: "flyio/hellofly:latest", guest }),
});

export { app, web, worker };
