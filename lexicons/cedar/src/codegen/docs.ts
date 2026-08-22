/**
 * The cedar lexicon's Starlight site.
 *
 * Prose pages are authored under `docs/pages/*.mdx`, each tagged with a
 * Diátaxis quadrant (chant #1731/#1733); the pipeline builds the sidebar from
 * that tag. Two more pages come out of the pipeline itself: the generated
 * rules table (`rules`) and the serialization reference. Both are linked from
 * the sidebar automatically.
 *
 * Cross-namespace links are written as full `/chant/...` paths. This site's
 * base is `/chant/lexicons/cedar/`, so a bare `/guide/...` would be rewritten
 * to `/chant/lexicons/cedar/guide/...`; the rehype plugin's idempotency check
 * leaves an already-project-rooted path alone. Sibling pages use `../slug/`,
 * because `./slug` from an MDX body resolves as a child.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── index ─────────────────────────────────────────────────────────

const overview = `The **cedar** lexicon is the typed authoring layer above [Cedar](https://www.cedarpolicy.com/), the vendor-neutral authorization policy language that joined the CNCF as a Sandbox project in December 2025.

Cedar is deliberately abstraction-free: no variables, no modules, no loops, and templates carrying exactly two slots (\`?principal\`, \`?resource\`). Its own toolchain validates and evaluates — it checks policies after they are written and decides requests at runtime. Everything upstream of the policy text is unowned, which is where this lexicon lives.

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-cedar
\`\`\`

## Quick start

\`\`\`typescript
import { Policy, ReadAction } from "@intentius/chant-lexicon-cedar";

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});
\`\`\`

\`ReadAction\` and \`"App::User"\` are generated from *your* Cedar schema, so a
renamed entity type is a compiler-guided refactor and a typo'd action is a
compile error — not a validation failure after the text is written.

## What comes out

| File | Who reads it |
|------|--------------|
| \`<name>.cedar\` | Every Cedar evaluator — Amazon Verified Permissions, cedar-agent, an embedded \`cedar-wasm\` |
| \`policies.cedar.json\` | The Cedar JSON policy format; also the parse source for import |

chant appears in neither. An emitted policy set walks away and is consumed by
any evaluator with chant nowhere in sight.

## Cedar is a target, never a gate

There is no \`cedarGate()\` and there will not be one.
[Organizational policy](/chant/guide/organizational-policy/) in chant is
TypeScript post-synth checks; a second policy engine would duplicate the lint
engine. chant compiles *to* Cedar; it is not governed *by* Cedar.

## The dogwood dialect

Cedar with temporal operators, shipping inside this lexicon as a pre-release
surface under the \`DWD\` id family: a policy that can depend on what already
happened in a session. Start at [The Dogwood Dialect](./dogwood), which is
honest about upstream's governance before it shows you a builder.`;

// ── Output format, for the generated serialization page ───────────

const outputFormat = `The cedar lexicon emits two views of one policy set.

**\`<name>.cedar\`** — the primary output, and the surface every Cedar evaluator reads.

\`\`\`cedar
@id("owner-read")
@doc("Owners always read their own documents.")
permit (
  principal is App::User,
  action in [App::Action::"read", App::Action::"list"],
  resource is App::Document
)
when { resource.owner == principal };
\`\`\`

**\`policies.cedar.json\`** — the Cedar JSON policy format, written alongside.

\`\`\`json
{
  "staticPolicies": {
    "owner-read": {
      "effect": "permit",
      "principal": { "op": "is", "entity_type": "App::User" },
      "action": { "op": "in", "entities": [{ "type": "App::Action", "id": "read" }] },
      "resource": { "op": "is", "entity_type": "App::Document" },
      "conditions": [{ "kind": "when", "body": { "__expr": "resource.owner == principal" } }],
      "annotations": { "id": "owner-read" }
    }
  },
  "templates": {},
  "templateLinks": []
}
\`\`\`

Both come from the same structured model in one pass, so they cannot drift. The
JSON form is also the parse source for import — see [Importing](../importing/).
`;

/**
 * Generate the docs site for the cedar lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "cedar",
    displayName: "Cedar",
    description: "Typed authoring for Cedar authorization policies",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/cedar/",
    overview,
    outputFormat,
    // Cedar declarations are namespaced `App::Document` and
    // `App::Action::"read"`, so the first segment is the namespace — which is
    // the only grouping a Cedar schema has.
    serviceFromType: (type: string) => type.split("::")[0] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.pages.size} pages, ${result.stats.resources} resources, ` +
        `${result.stats.properties} property types, ${result.stats.rules} rules`,
    );
  }
}
