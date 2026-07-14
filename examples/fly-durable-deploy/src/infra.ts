import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

// One Fly app and one machine — the smallest complete deploy. The serializer
// (#738) turns these into the flaps create bodies flyApply POSTs: the App into
// `POST /v1/apps { app_name, org_slug }`, the Machine into
// `POST /v1/apps/fly-durable-demo/machines { name, region, config }` (a machine's
// owning app is the stack's sole app when it names none).
//
// `org_slug` is required by the Machines API (real Fly rejects app creation
// without it). `Fly.OrgSlug` resolves from the `FLY_ORG` env at build time,
// defaulting to `personal` offline.
//
// The machine carries no manual metadata: the serializer stamps the
// `managed-by: chant` ownership marker into `config.metadata` on its own, which
// is what the owned-only prune reads back (D2).
const app = new App({ name: "fly-durable-demo", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});

export { app, web };
