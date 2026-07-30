/**
 * fountain documentation generator.
 *
 * Calls the core docsPipeline with fountain-specific config. The reference
 * pages (resources, composites, ops, adoption, skills) are declared as
 * `extraPages` rather than left as hand-written files in docs/: the sidebar is
 * rebuilt from generated pages on every run, so a page the config does not
 * know about exists but cannot be navigated to.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const overview = `The **fountain** lexicon declares [fountain](https://github.com/BinaryBourbon/fountain)'s workload layer as typed chant resources. fountain runs coding agents in sandboxed VMs; its three declarable kinds are \`Environment\` (sandbox baseline), \`Vault\` (env-var overrides), and \`Agent\` (a runnable agent config).

Types are generated from fountain's served OpenAPI spec, so they track the real API.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-fountain
\`\`\`

## Quick Start

\`\`\`typescript
import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

export const env = new Environment({
  name: "team-env",
  networking_type: "limited",                    // FTN010 requires explicit intent
  networking_config: { allowed_hosts: ["github.com"] },
  metadata: { "managed-by": "chant" },           // enables owned-only reconcile/prune
});

export const helper = new Agent({
  name: "helper",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: env,                              // typed ref — dangling name = build error
});
\`\`\`

## The loop

1. \`chant build\` — synthesize and lint. The FTN rules catch open networking, credential literals, and unresolvable \`\${VAR}\` references before review.
2. \`chant run <apply op>\` or call \`fountainApply\` — reconcile against the API. Idempotent by name.
3. \`chant lifecycle diff --live\` — drift. A UI edit to an owned Environment shows up here.
4. \`chant import --from\` — adopt UI-built resources into typed files.

## Endpoint and auth

\`FOUNTAIN_ENDPOINT\` (defaults to the hosted instance) and \`FOUNTAIN_TOKEN\`. Mint a token via \`POST /api/auth/token\` with email and password, or from the account UI. The same code applies to a local \`mix phx.server\` fountain by pointing \`FOUNTAIN_ENDPOINT\` at it — registration and token mint work headless, so CI needs no browser.`;

const outputFormat = `The fountain lexicon serializes to fountain's own manifest YAML plus a \`fountain-plan.json\` sidecar.

## Manifests

Each declared resource becomes a manifest document with \`apiVersion: fountain.dev/v1\`:

\`\`\`yaml
apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: team-env
spec:
  networking_type: limited
  networking_config:
    allowed_hosts:
      - github.com
\`\`\`

The output is ejectable — \`fountain apply -f\` accepts it verbatim, so adopting chant here does not trap the manifests behind chant.

## The plan sidecar

\`fountain-plan.json\` is entity name → \`{ kind, spec }\`. The \`fountainApply\` activity reconciles from it directly against the REST API, so nothing on the apply side parses YAML. Apply order is Environment → Vault → Agent; an agent's \`environment\` reference carries the entity name and is resolved to the live id at apply.

## Ownership

Resources carrying \`metadata."managed-by": chant\` are chant-owned. That marker gates the opt-in prune (\`fountainApply\` deletes only owned resources absent from the plan) and the \`--owned\` filter on drift and live export. Set it on every declaration you want reconciled.

## Secrets

\`spec.secrets\` entries are split out of the resource body and upserted through the secrets sub-resource. Values are write-only upstream, so this is upsert-always — a changed value cannot be detected, only overwritten.`;

const resourcesPage = `The lexicon types the three kinds \`fountain apply\` reconciles — the workload
layer of [fountain](https://github.com/BinaryBourbon/fountain). Types are
generated from fountain's served OpenAPI spec, so they track the real API.
Conversations are deliberately **not** a resource: they are runs with a
status lifecycle, modeled as ops.

## Environment

A reusable sandbox baseline: packages, repos, setup script, env vars,
encrypted secrets, and the networking policy. \`networking_type\` is
\`"unrestricted" | "limited"\`; under \`limited\`, egress is restricted to
\`networking_config.allowed_hosts\`, and with no hosts (or an empty list) the
sandbox denies all egress — a deny-all, not an allow-all. FTN010 requires the
networking intent to be explicit.

## Vault

A bag of env-var overrides selected at conversation create. Vault values
win on key collision with the environment — which is why agents can carry
a vault allowlist upstream (fountain#136). \`allowed_vault_ids\` on an Agent is
three-state: \`null\` allows any tenant vault, \`[]\` forbids all, a list is an
allowlist.

## Agent

A named, re-runnable agent configuration: model, runtime, skills (inline
SKILL.md or GitHub-sourced with a \`ref\` pin), MCP servers, and an optional
\`environment\` reference — typed, so a dangling reference is a build error,
not a 422 at apply time.

## Example

\`\`\`ts
import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

export const conciergeEnv = new Environment({
  name: "concierge-env",
  networking_type: "limited",
  networking_config: { allowed_hosts: ["registry.npmjs.org", "github.com"] },
  metadata: { "managed-by": "chant" },
});

export const researcher = new Agent({
  name: "researcher",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: conciergeEnv,
  skills: [{ source: "vercel-labs/agent-skills", ref: "main" }],
});
\`\`\``;

const compositesPage = `## ConciergeStack

An Environment + Agent pair with the secure-by-construction defaults for agents that touch anything sensitive:

\`\`\`typescript
import { ConciergeStack } from "@intentius/chant-lexicon-fountain";

export const { environment, agent } = ConciergeStack({
  name: "concierge",
  model: "anthropic/claude-sonnet-4-6",
  allowedHosts: ["registry.npmjs.org", "github.com"],
});
\`\`\`

| Default | Effect |
|---|---|
| \`networking_type: limited\` with an empty allowlist | deny-all egress — fountain's isolation mode |
| \`allowed_vault_ids: []\` | no conversation may override the reviewed environment at spawn |
| \`managed-by: chant\` on both | owned-only reconcile, prune, and drift filtering see them |

Every default is the closed one, so loosening any of it is a visible, reviewable act: pass an allowlist, pass vault ids, or drop to the raw classes.

Give such a sandbox **no cloud credentials of any kind** — anything readable inside it is exfiltratable by prompt injection. Services the agent needs live outside the sandbox behind their own auth; the sandbox gets at most a conversation-scoped token.`;

const opsPage = `Two op activities ship with the lexicon, resolvable by name via \`loadActivities(["fountain"])\`.

## fountainApply

The native applier: a direct-REST reconciler over the serializer's \`fountain-plan.json\`.

| Behavior | Detail |
|---|---|
| Create / update | By name. A resource in the plan that exists live is updated; one that does not is created. |
| Order | Environment → Vault → Agent, so an agent's environment reference resolves to a live id. |
| Prune | Off by default. With \`prune: true\`, chant-owned resources absent from the plan are deleted, in reverse order. |
| Secrets | Split from the body and upserted through the secrets sub-resource. Upsert-always — values are write-only upstream. |

\`\`\`typescript
await fountainApply({ planPath: "build/fountain-plan.json", prune: true });
\`\`\`

Endpoint and token resolution: explicit args win, then \`FOUNTAIN_ENDPOINT\` / \`FOUNTAIN_TOKEN\`, then the hosted default.

## fountainRun

Conversations are runs, not resources, so they are started rather than declared. \`fountainRun\` resolves the agent by name, starts a conversation (optionally with a prompt and an allowlisted vault), polls to \`completed | failed | timed_out\`, and terminates at its deadline so a hung sandbox never outlives the op.

Multi-turn interaction — follow-up prompts, interrupt — is fountain's own conversations API. The lexicon stays at the lifecycle edges.`;

const adoptionPage = `The lexicon reads live fountain state on three paths.

## Drift

\`chant lifecycle diff --live\` reports each declared entity as observed present, observed absent, or **not observed** with a reason — a read failure is never reported as an absence, which would propose a spurious create. Ownership comes from the \`managed-by: chant\` marker, so \`--owned\` filters to what chant declared.

An out-of-band change to a locked environment — a UI edit that adds a secret, opens networking, or drops the marker — is what this catches. Wire it into a scheduled watch and treat a hit as an incident, not housekeeping.

## Import

\`chant import --from\` adopts UI-built resources into typed files. Server-written fields are stripped to the authored shape, and an agent's \`environment_id\` is resolved back to the exported environment's logical name so the generated code carries a reviewable reference.

Secrets do not round-trip: values are write-only upstream and secret keys are not on the typed request surface, so environments export without them and the caller is warned per environment that carried any. Re-declare them through your secret provider.

## Graph

\`chant graph --live\` reconstructs the topology from one edge: an Agent runs in an Environment. Vaults are deliberately edge-free — vault-to-agent binding is a conversation-time choice scoped by \`allowed_vault_ids\`, not standing topology.`;

const skillsPage = `Three agent skills ship with the lexicon and load automatically in a project that uses it.

| Skill | Covers |
|---|---|
| \`chant-fountain\` | The core authoring loop — declaring the three kinds, the build/apply/drift/import cycle, endpoint and auth |
| \`chant-fountain-secrets\` | Secrets, \`env_vars\`, and \`\${VAR}\` substitution: the order of preference, vault precedence, and what does not round-trip |
| \`chant-fountain-locked-sandboxes\` | The locked-down posture for untrusted or security-sensitive agents, and running conversations against them |

Invoke one directly by name, or let it trigger on context (\`fountain\`, \`vault\`, \`sandbox\`, \`networking_type\`).`;

/**
 * Generate documentation site for the fountain lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "fountain",
    displayName: "Fountain",
    description: "Fountain workload primitives (Environment, Vault, Agent) as typed estate.",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/fountain/",
    overview,
    outputFormat,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    // No `resourceTypeUrl` key: DocsConfig has none, so passing it was a
    // silent no-op. The upstream reference link lives in the resources page
    // content, where it actually renders.
    extraPages: [
      {
        slug: "resources",
        title: "Resources",
        description: "The three fountain workload kinds the lexicon declares.",
        content: resourcesPage,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "ConciergeStack — a locked-down Environment and Agent pair.",
        content: compositesPage,
      },
      {
        slug: "ops",
        title: "Ops",
        description: "fountainApply and fountainRun — the applier and the conversation runner.",
        content: opsPage,
      },
      {
        slug: "adoption",
        title: "Drift and Adoption",
        description: "Live observation, import, and the graph edge fountain reconstructs.",
        content: adoptionPage,
      },
      {
        slug: "skills",
        title: "Skills",
        description: "The agent skills the lexicon ships.",
        content: skillsPage,
      },
    ],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
