/**
 * `chant init` scaffolding for cpln projects.
 *
 * Three templates, chosen so the default is the shape most people actually
 * start with and the other two are the two directions it grows in. Each is
 * written to pass this lexicon's own checks as scaffolded — a template that
 * emits CPL findings on first build teaches the wrong lesson about what the
 * findings mean.
 */

import type { InitTemplateSet } from "@intentius/chant/lexicon";

const DEFAULT = `import { GvcEnvironment, ServerlessService } from "@intentius/chant-lexicon-cpln";

// A GVC and one public serverless service.
//
// Placement lives on the GVC, not the workload — locationLinks is what decides
// where anything in this environment runs. Set CPLN_ORG to your org name.
const org = process.env.CPLN_ORG ?? "my-org";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  locations: ["aws-us-east-1"],
});

// Serverless requires exactly one HTTP port, and the external firewall starts
// closed in both directions — so a public service says so explicitly. Egress is
// left closed; open it to the hosts this actually calls.
export const { workload } = ServerlessService({
  name: "web",
  gvc: "prod",
  image: "nginx:1.27",
  port: 8080,
  inboundAllowCidr: ["0.0.0.0/0"],
});
`;

const WITH_SECRETS = `import {
  GvcEnvironment,
  ServerlessService,
  SecretAccess,
  Secret,
  secretRef,
} from "@intentius/chant-lexicon-cpln";

// A service that reads a secret at runtime.
//
// Reading a secret takes three things, and missing any one fails *silently* at
// runtime rather than at apply: an identity on the workload, a policy granting
// that identity \`reveal\`, and a field-qualified reference. SecretAccess owns
// the first two; secretRef() is the third.
const org = process.env.CPLN_ORG ?? "my-org";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  locations: ["aws-us-east-1"],
});

// The value is a placeholder. Set the real one with \`cpln secret edit\`, or
// point this at a value read from the environment at build time — never a
// literal in source (CPL001).
export const dbPassword = new Secret({
  name: "db-password",
  type: "opaque",
  data: { payload: process.env.DB_PASSWORD ?? "changeme", encoding: "plain" },
});

export const { identity, policy } = SecretAccess({
  name: "web-identity",
  gvc: "prod",
  secrets: ["db-password"],
});

export const { workload } = ServerlessService({
  name: "web",
  gvc: "prod",
  image: "nginx:1.27",
  port: 8080,
  inboundAllowCidr: ["0.0.0.0/0"],
  identityLink: "//gvc/prod/identity/web-identity",
  env: {
    DATABASE_PASSWORD: secretRef("db-password", "payload"),
  },
});
`;

const STATEFUL = `import { GvcEnvironment, StatefulService } from "@intentius/chant-lexicon-cpln";

// A stateful service with persistent storage.
//
// Both fileSystemType and performanceClass are immutable — changing either
// later means delete, recreate, and data loss — so they are worth settling
// before the first apply. ext4 binds to exactly one stateful workload; use
// "shared" if several workloads need the same volume.
const org = process.env.CPLN_ORG ?? "my-org";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  locations: ["aws-us-east-1"],
});

export const { workload, volumeSet } = StatefulService({
  name: "db",
  gvc: "prod",
  image: "postgres:17",
  mountPath: "/var/lib/postgresql/data",
  capacityGb: 20,
  fileSystemType: "ext4",
  performanceClass: "general-purpose-ssd",
  ports: [{ number: 5432, protocol: "tcp" }],
  env: { POSTGRES_DB: "app" },
});
`;

/**
 * Return the scaffold for a template name. Unknown names fall back to the
 * default rather than erroring — `chant init` treats the name as a hint.
 */
export function cplnInitTemplates(template?: string): InitTemplateSet {
  switch (template) {
    case "secrets":
      return { src: { "infra.ts": WITH_SECRETS } };
    case "stateful":
      return { src: { "infra.ts": STATEFUL } };
    default:
      return { src: { "infra.ts": DEFAULT } };
  }
}
