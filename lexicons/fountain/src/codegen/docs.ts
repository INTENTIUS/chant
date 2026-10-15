/**
 * fountain documentation generator.
 *
 * Calls the core docsPipeline with fountain-specific config. The reference
 * pages (resources, composites, ops, adoption, skills) live as authored MDX
 * under `docs/pages/`, each tagged with its Diátaxis quadrant; the sidebar is
 * grouped from that field (chant #1731 / #1733).
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const overview = `The **fountain** lexicon declares [Managoat](https://github.com/managoat/managoat)'s workload layer (formerly fountain) as typed chant resources. Managoat runs coding agents in sandboxed VMs. Three kinds are declarable, the three \`fountain apply\` reconciles: \`Environment\` (sandbox baseline), \`Vault\` (env-var overrides) and \`Agent\` (a runnable agent config). Conversations are runs, not resources: start them with the \`fountainRun\` op.

\`Teammate\`, \`Schedule\` and \`Webhook\` are still exported, but Managoat removed the team, its scheduler and webhooks (managoat/managoat#2793): declaring one fails the build with FTN025, which names what replaced it. A long-lived thread is one conversation resumed by \`channel_id\` (what a \`Steward\`'s runs use), and a cadence is a clock outside Managoat running \`chant run <op> --on fountain\`. See [Coming from the team kinds](#coming-from-the-team-kinds) below.

Types are generated from a pinned fountain release's OpenAPI spec, so they track the real API.

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
  environment: env,                              // typed ref, serialized by name
});
\`\`\`

## The loop

1. \`chant build\` — synthesize and lint. The FTN rules catch open networking, credential literals, and unresolvable \`\${VAR}\` references before review. The same rules run via [\`chant audit\`](/chant/cli/audit/) over a repo of hand-written \`fountain apply\` manifests — no chant project needed; the documents are parsed back into the entity graph.
2. \`chant run <apply op>\` or call \`fountainApply\` — reconcile against the API. Idempotent by name.
3. \`chant lifecycle diff --live\` — drift. A UI edit to an owned Environment shows up here.
4. \`chant import --from\` — adopt UI-built resources into typed files.

## Endpoint and auth

\`FOUNTAIN_ENDPOINT\` (defaults to the hosted instance) and \`FOUNTAIN_TOKEN\`. Mint a token via \`POST /api/auth/token\` with email and password, or from the account UI. The same code applies to a local \`mix phx.server\` fountain by pointing \`FOUNTAIN_ENDPOINT\` at it — registration and token mint work headless, so CI needs no browser.

## Coming from the team kinds

Managoat removed these between v0.21.0 and v0.29.0, the pinned spec. Each now fails the build with FTN025, and \`chant import\` skips its documents:

| Was | Now |
|---|---|
| \`Teammate\` (an agent on the team, with a thread) | One conversation resumed by \`channel_id\`. A \`Steward\`'s runs go to \`chant:steward:<name>\`; its sandbox keeps its disk across park and wake. Or \`--on e2b\`, a sandbox of your own. |
| \`Schedule\` (a cron prompt into that thread) | A clock outside Managoat — a CI \`schedule:\`, a CronJob — running \`chant run <op> --on fountain\`. The cadence stays on the Op. |
| \`Webhook\` | Nothing upstream. Read a run's outcome from \`chant run\`, or the conversation's event stream. |
| Agent \`sandbox_mode: "persistent"\` | Drop it: every conversation gets a sandbox of its own, and \`persistent\` is a 422. |
| \`sandbox_provider\` \`daytona\` or \`runner\` | \`sprites\` or \`e2b\`, or unset for the instance default. |
| \`runtime: "opencode"\` | \`claude\`, \`codex\`, \`gemini\` or \`acp\`. |
| \`fountain.profiles.<name>.team\` | \`steward\`, the steward's name. |`;

const outputFormat = `The fountain lexicon serializes to fountain's own manifest YAML — nothing else. \`fountainApply\` reads that same YAML, so there is no sidecar to keep in sync with it.

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

Documents come out in dependency order — Environment, Vault, Agent — whatever order the file declared them in, so the manifest reads the way it applies. Within one kind, declaration order is kept.

\`metadata.name\` is the resource's declared \`name\`, not the name of the variable you exported it as. fountain reconciles by that name, so renaming the variable does not orphan the resource. An entity declared without a \`name\` falls back to the export name. The name appears only in \`metadata\`; it is not repeated under \`spec\`, so the apply request carries one name per resource.

The output is ejectable — \`fountain apply -f\` accepts it verbatim, so adopting chant here does not trap the manifests behind chant.

## Applying the manifest

\`fountainApply\` parses this same YAML and sends it to fountain's bulk \`POST /api/apply\` endpoint in one request — the server reconciles by name, Environment then Vault then Agent, and resolves an agent's \`environment\` reference itself, against the manifest or the tenant's existing environments. See the Ops page for the activity's own behavior (prune, secrets, failure reporting).

A \`Teammate\`, \`Schedule\` or \`Webhook\` is never written to the manifest: Managoat removed them, and FTN025 fails the build that declares one.

## Ownership

Resources carrying \`metadata."managed-by": chant\` are chant-owned. That marker gates the opt-in prune (\`fountainApply\` deletes only owned resources absent from the manifest) and the \`--owned\` filter on drift and live export. Set it on every declaration you want reconciled.

## Secrets

\`spec.secrets\` is authored as an ordered \`{key, value}[]\`, same as any other typed prop. \`fountainApply\` converts it to the \`{KEY: value}\` map fountain's bulk apply expects on the wire; the server upserts it through the encrypted envelope path. Values are write-only upstream, so this is upsert-always — a changed value cannot be detected, only overwritten.`;

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
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
