/**
 * Getting-started example for the fly lexicon.
 *
 * One Fly app and one machine — the smallest complete deploy. The serializer
 * (#738) turns these into the flaps create bodies flyApply POSTs. The region
 * comes from Fly.Region (resolved from FLY_REGION, defaulting to "iad").
 */
import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: Fly.Region,
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});

export { app, web };
