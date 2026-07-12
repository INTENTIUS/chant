import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

// The Fly infra the agent deploys: one App and one Machine — the smallest
// complete deploy. This is the same declarative resource model as
// examples/local-fly; here it is the payload the agent applies from inside a
// checkpointed Sprite.
//
// The fly serializer (`build:fly`) turns these into the flaps create bodies
// `flyApply` POSTs: the App into `POST /v1/apps { app_name, org_slug }`, the
// Machine into `POST /v1/apps/fly-agent-demo/machines { name, region, config }`.
// `org_slug` is required by the Machines API (real Fly rejects app creation
// without it); `Fly.OrgSlug` resolves from `FLY_ORG` at build time, default
// `personal`. `region: "iad"` is a real Fly region, so the FLY001 region lint
// passes. The serializer stamps `managed-by: chant` into `config.metadata` on
// its own — the ownership marker the owned-only prune reads back.
const app = new App({ name: "fly-agent-demo", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});

export { app, web };
