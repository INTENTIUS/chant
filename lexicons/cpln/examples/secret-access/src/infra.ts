/**
 * A service that reads a secret at runtime.
 *
 * All three steps of Control Plane's secret access path, which is worth
 * spelling out because **missing any one of them fails silently at runtime**
 * rather than at apply: the identity, the policy granting it `reveal`, and the
 * field-qualified reference.
 */

import {
  GvcEnvironment,
  ServerlessService,
  SecretAccess,
  Secret,
  identityLink,
  secretRef,
} from "@intentius/chant-lexicon-cpln";

const org = process.env.CPLN_ORG ?? "acme";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  locations: ["aws-us-east-1"],
});

/**
 * The value comes from the environment at build time. A literal here would be
 * a credential in git history, which CPL001 catches at author time.
 */
export const dbPassword = new Secret({
  name: "db-password",
  type: "opaque",
  data: { payload: process.env.DB_PASSWORD ?? "changeme", encoding: "plain" },
});

/**
 * Steps 1 and 2: the identity, and a policy granting it `reveal` on the
 * secret. The principal link is GVC-qualified — the bare `//identity/NAME`
 * form is accepted by Control Plane and then silently ignored (CPL013).
 */
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
  identityLink: identityLink("prod", "web-identity"),
  env: {
    // Step 3. The field qualifier is required — `cpln://secret/db-password`
    // with no `.payload` resolves to nothing (CPL014).
    DATABASE_PASSWORD: secretRef("db-password", "payload"),
  },
});
