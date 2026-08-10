/**
 * `chant init --lexicon cedar --template <name>` scaffolds.
 *
 * Every template ships a `schema.cedarschema` at the project root. That is not
 * decoration: cedar's codegen input is the project's own schema (epic #1645),
 * and a scaffold without one generates against the bundled default — a project
 * whose typed classes describe somebody else's entity model.
 *
 * The filename is fixed rather than configured because `schema.cedarschema` in
 * the project root is step 2 of the resolution order in `spec/fetch.ts`, so a
 * scaffolded project needs no `cedar.schema` key at all. It also has to be
 * fixed: core writes `chant.config.ts` before a plugin's root files and
 * `writeIfNotExists` keeps the first one, so a template that shipped its own
 * config would be silently discarded. The README each template ships is where
 * `requireProjectSchema` gets recommended, which is the honest place for advice
 * a scaffold cannot enforce.
 *
 * The policy files use `entityType`-string scopes (`{ is: "App::Document" }`)
 * and generated action constants, so a scaffolded project compiles the moment
 * `chant generate` has run against its own schema.
 */

import type { InitTemplateSet } from "@intentius/chant/lexicon";

/** Filename every template writes its schema to — see spec/fetch.ts step 2. */
const SCHEMA_FILE = "schema.cedarschema";

function readme(title: string, body: string): string {
  return `# ${title}

\`\`\`bash
npm install
npx chant generate --lexicon cedar   # schema.cedarschema -> typed classes
npx chant build                      # emits .cedar text + policies.cedar.json
\`\`\`

Generate first. The classes and action constants \`src/policies.ts\` imports do
not exist until \`chant generate\` has read \`${SCHEMA_FILE}\`.

${body}

## Before this is real

Add \`requireProjectSchema\` once you are past the scaffold:

\`\`\`typescript
// chant.config.ts
export default {
  lexicons: ["cedar"],
  cedar: {
    validation: { mode: "strict", requireProjectSchema: true },
  },
} satisfies ChantConfig;
\`\`\`

Without it, deleting or renaming \`${SCHEMA_FILE}\` falls back to the schema
bundled with the lexicon and the build still succeeds — against an entity model
this project never declared.

## What comes out

| File | Who reads it |
|------|--------------|
| \`dist/*.cedar\` | Every Cedar evaluator — AVP, cedar-agent, an embedded cedar-wasm |
| \`dist/policies.cedar.json\` | The Cedar JSON policy format; also the parse source for import |
`;
}

// ── default ───────────────────────────────────────────────────────

const DEFAULT_SCHEMA = `// The entity model your policies are typed against.
//
// \`chant generate --lexicon cedar\` turns every declaration below into a
// TypeScript class or constant, so a renamed entity type becomes a
// compiler-guided refactor rather than a runtime validation failure.

namespace App {
  entity User = {
    "email": String,
    "department": String,
  };

  entity Document = {
    "title": String,
    "owner": User,
    "classification": String,
  };

  action read, write appliesTo {
    principal: [User],
    resource: [Document],
    context: {
      "mfa": Bool,
    }
  };
}
`;

const DEFAULT_POLICIES = `import { Policy, ReadAction, WriteAction } from "@intentius/chant-lexicon-cedar";

/**
 * A permit and a forbid — the smallest policy set worth deploying.
 *
 * Cedar is default-deny, so the permit is what grants anything at all. The
 * forbid is not the absence of a grant: it beats every permit in the set
 * unconditionally, which is what makes it survive a wider grant added later.
 */

/** Owners read and write their own documents. */
export const ownerAccess = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { in: [ReadAction, WriteAction] },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});

/** Nothing confidential moves without MFA, owner or not. */
export const requireMfaOnConfidential = new Policy({
  effect: "forbid",
  principal: { is: "App::User" },
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: ["context.mfa == true"],
});
`;

// ── avp-embedding ─────────────────────────────────────────────────

const AVP_SCHEMA = `// The entity model behind an Amazon Verified Permissions policy store.
//
// AVP is one deployment vehicle for Cedar; the schema and the policies are
// ordinary Cedar either way, and the same emitted \`.cedar\` file is read by any
// other evaluator with no AWS involved.

namespace Store {
  entity Tenant = {
    "name": String,
  };

  entity User in [Tenant] = {
    "email": String,
    "tenant": Tenant,
    "admin": Bool,
  };

  entity Record in [Tenant] = {
    "tenant": Tenant,
    "owner": User,
    "sensitive": Bool,
  };

  action view, edit appliesTo {
    principal: [User],
    resource: [Record],
    context: {
      "mfa": Bool,
    }
  };
}
`;

const AVP_POLICIES = `import { Policy, EditAction, ViewAction } from "@intentius/chant-lexicon-cedar";

/**
 * Policies destined for an AVP policy store.
 *
 * The statement each of these serializes to is what goes in a
 * \`AWS::VerifiedPermissions::Policy\`'s \`definition.static.statement\` — the
 * same bytes as the emitted \`.cedar\` file, so the deployed policy and the
 * reviewed file cannot disagree.
 *
 * The typed handoff (a VerifiedPermissionsPolicy whose statement accepts a
 * Policy value directly, plus the policy-store lifecycle and the ownership
 * channel) is landing with INTENTIUS/chant#1652. Until it does, emit the
 * \`.cedar\` file and reference its text; do not hand-type a statement string.
 */

/** Tenancy: nobody touches a record outside their own tenant. */
export const tenantIsolation = new Policy({
  effect: "forbid",
  principal: { is: "Store::User" },
  resource: { is: "Store::Record" },
  unless: ["resource.tenant == principal.tenant"],
});

/** Members view records in their tenant. */
export const tenantView = new Policy({
  effect: "permit",
  principal: { is: "Store::User" },
  action: { eq: ViewAction },
  resource: { is: "Store::Record" },
  when: ["resource.tenant == principal.tenant"],
});

/** Owners and tenant admins edit; sensitive records also demand MFA. */
export const ownerEdit = new Policy({
  effect: "permit",
  principal: { is: "Store::User" },
  action: { eq: EditAction },
  resource: { is: "Store::Record" },
  when: ["resource.owner == principal || principal.admin == true"],
  unless: ["resource.sensitive == true && context.mfa == false"],
});
`;

// ── gateway-policy-set ────────────────────────────────────────────

const GATEWAY_SCHEMA = `// An API gateway's authorization model.
//
// The principal is a caller identity, the resource is a route, and the action
// is an HTTP method. Modelling routes as entities rather than strings is what
// lets a policy say \`resource.public == true\` instead of matching paths.

namespace Gateway {
  entity Scope = {
    "name": String,
  };

  entity Caller in [Scope] = {
    "clientId": String,
    "internal": Bool,
  };

  entity Route = {
    "path": String,
    "public": Bool,
    "deprecated": Bool,
  };

  action get, post, delete appliesTo {
    principal: [Caller],
    resource: [Route],
    context: {
      "sourceIp": String,
      "authenticated": Bool,
    }
  };
}
`;

const GATEWAY_POLICIES = `import {
  DeleteAction,
  DenyByDefaultSet,
  GetAction,
  Policy,
  PostAction,
} from "@intentius/chant-lexicon-cedar";

/**
 * A gateway policy set with an explicit deny floor.
 *
 * \`DenyByDefaultSet\` returns the forbid and the permits it governs from one
 * call, so the floor cannot be deleted in a refactor while the grants survive.
 * A forbid beats every permit unconditionally — that is the whole reason to
 * write one under a default-deny engine.
 */

/** Anonymous callers reach public routes, read-only. */
const publicRead = new Policy({
  effect: "permit",
  principal: { is: "Gateway::Caller" },
  action: { eq: GetAction },
  resource: { is: "Gateway::Route" },
  when: ["resource.public == true"],
});

/** Authenticated callers may write. */
const authenticatedWrite = new Policy({
  effect: "permit",
  principal: { is: "Gateway::Caller" },
  action: { in: [PostAction, DeleteAction] },
  resource: { is: "Gateway::Route" },
  when: ["context.authenticated == true"],
});

/** Deprecated routes are closed to everyone but internal callers. */
const guarded = DenyByDefaultSet({
  policies: [publicRead, authenticatedWrite],
  entityType: "Gateway::Route",
  when: ["resource.deprecated == true"],
  unless: ["principal.internal == true"],
  annotations: { id: "deprecated-route-floor" },
});

export const deprecatedRouteFloor = guarded.floor;
export const publicReadGrant = guarded.members[0];
export const authenticatedWriteGrant = guarded.members[1];
`;

// ── The template set ──────────────────────────────────────────────

/**
 * Scaffolds for `chant init`.
 *
 * An unrecognized name falls through to the default rather than throwing —
 * the same behaviour every other lexicon's `initTemplates` has.
 */
export function cedarInitTemplates(template?: string): InitTemplateSet {
  const scripts = {
    generate: "chant generate --lexicon cedar",
    build: "chant build",
  };

  if (template === "avp-embedding") {
    return {
      src: { "policies.ts": AVP_POLICIES },
      root: {
        [SCHEMA_FILE]: AVP_SCHEMA,
        "README.md": readme(
          "Cedar policies for a Verified Permissions store",
          "The `Store` namespace models a multi-tenant record store. `tenantIsolation` is a\n" +
            "`forbid`, deliberately: a forbid beats every permit in the set unconditionally,\n" +
            "so a tenancy boundary written that way survives a wider grant added later.\n\n" +
            "The statement each policy serializes to is what goes in an\n" +
            "`AWS::VerifiedPermissions::Policy`. The typed handoff is landing with\n" +
            "INTENTIUS/chant#1652 — until then, reference the emitted `.cedar` text rather\n" +
            "than hand-typing a statement string.",
        ),
      },
      scripts,
    };
  }

  if (template === "gateway-policy-set") {
    return {
      src: { "policies.ts": GATEWAY_POLICIES },
      root: {
        [SCHEMA_FILE]: GATEWAY_SCHEMA,
        "README.md": readme(
          "Cedar policies for an API gateway",
          "Routes are entities, not path strings, which is what lets a policy say\n" +
            "`resource.public == true` instead of matching globs. The `DenyByDefaultSet`\n" +
            "composite returns the deprecated-route floor and the grants it governs from one\n" +
            "call, so a refactor cannot delete the floor and leave the grants behind.",
        ),
      },
      scripts,
    };
  }

  return {
    src: { "policies.ts": DEFAULT_POLICIES },
    root: {
      [SCHEMA_FILE]: DEFAULT_SCHEMA,
      "README.md": readme(
        "Cedar policies",
        "One permit and one forbid. Cedar is default-deny, so the permit is what grants\n" +
          "anything at all; the forbid is not the absence of a grant but an override that\n" +
          "beats every permit in the set.",
      ),
    },
    scripts,
  };
}

/** Every template name this lexicon scaffolds, for docs and tests. */
export const CEDAR_INIT_TEMPLATES = ["default", "avp-embedding", "gateway-policy-set"] as const;
