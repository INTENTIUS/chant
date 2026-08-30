// The stack a PR gets a live copy of: one Fly app and one machine, every
// physical name interpolating the env parameter so two PR environments
// coexist. The serializer stamps the ownership marker (managed-by +
// chant-stack + chant-env, resolved from the same parameter) into
// config.metadata — the identity the on-close teardown selects on.

import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";
import { params } from "@intentius/chant/params";

const env = params.env as string;

export const app = new App({ name: `preview-${env}`, org_slug: Fly.OrgSlug });

export const web = new Machine({
  name: `web-${env}`,
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});
