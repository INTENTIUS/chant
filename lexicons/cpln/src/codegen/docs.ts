/**
 * cpln documentation generator.
 *
 * Calls the core `docsPipeline` with cpln-specific config. The reference pages
 * are declared as `extraPages` rather than left as hand-written files in
 * `docs/`: the sidebar is rebuilt from generated pages on every run, so a page
 * the config does not know about exists but cannot be navigated to.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const overview = `The **cpln** lexicon declares [Control Plane](https://controlplane.com) infrastructure as typed chant resources. Control Plane is a hybrid multi-cloud platform: workloads deploy into Global Virtual Clouds that span AWS, GCP, Azure and private clouds, with geo-routing, TLS termination and identity-based cloud access handled by the platform.

Types are generated from Control Plane's served OpenAPI document (\`https://api.cpln.io/openapi.json\`), so they track the real API.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-cpln
\`\`\`

## Quick Start

\`\`\`typescript
import { Gvc, Workload } from "@intentius/chant-lexicon-cpln";

export const gvc = new Gvc({
  name: "prod",
  spec: {
    staticPlacement: {
      locationLinks: ["/org/acme/location/aws-us-east-1"],   // placement is GVC-level
    },
  },
});

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: {
    type: "serverless",                                       // exactly one HTTP port
    containers: [{
      name: "main",
      image: "nginx:1.27",
      ports: [{ number: 8080, protocol: "http" }],
    }],
    firewallConfig: {
      external: { inboundAllowCIDR: ["0.0.0.0/0"] },          // closed by default
    },
  },
});
\`\`\`

## The loop

1. \`chant build\` — synthesize and lint. The CPL rules catch the silent failures Control Plane does not report: an unqualified identity link, a scale-to-zero that never happens, a secret reference with no field.
2. \`cpln apply --file dist/cpln.yaml --ready\` — reconcile. Ordering across documents is resolved by \`cpln apply\` itself.
3. \`chant plan\` — read the live org back and diff. Ownership comes from the \`tags\` marker chant stamps at synthesis.
`;

const outputFormat = "multi-document Control Plane YAML for `cpln apply --file`";

const resourcesPage = `The lexicon models eight kinds — the workload surface rather than every kind the API exposes.

## Org-scoped

| Class | \`kind\` | What it is |
|---|---|---|
| \`Gvc\` | \`gvc\` | Global Virtual Cloud — the placement and networking boundary |
| \`Secret\` | \`secret\` | An org-scoped secret, in one of 12 types |
| \`Policy\` | \`policy\` | Permissions bound to principals over a target |
| \`Domain\` | \`domain\` | A custom domain with TLS, CORS and routing |
| \`IpSet\` | \`ipset\` | Dedicated IP addresses bound to a workload |

## GVC-scoped

These take a required \`gvc\`.

| Class | \`kind\` | What it is |
|---|---|---|
| \`Workload\` | \`workload\` | A running unit of work — serverless, standard, stateful or cron |
| \`Identity\` | \`identity\` | Cloud access and network grants; the principal a policy grants to |
| \`VolumeSet\` | \`volumeset\` | Persistent storage for stateful workloads |

## The \`gvc\` property

The OpenAPI document has no \`gvc\` field on \`workload\` — the GVC is a URL segment there. The \`cpln apply\` manifest format does have one, and Control Plane's guidance is that you set either the manifest key or the \`--gvc\` flag, not both. This lexicon always uses the key, so an emitted manifest is self-contained and does not depend on how it is applied.

\`identity\` and \`volumeset\` carry a \`gvc\` of their own in the spec, in two different shapes. All three are normalized to the same required \`gvc: string\`.

## What is not modelled

Not out of reach, just out of the first pass — each is a row in \`src/kinds.ts\` away: \`group\`, \`serviceaccount\`, \`cloudaccount\`, \`auditctx\`, \`agent\`, \`user\`, \`image\`, \`location\`, \`org\`, \`mk8s\`. \`chant cpln coverage\` reports the gap rather than hiding it.

## One untyped subtree

\`spec.sidecar.envoy\` on \`gvc\` and \`workload\` resolves to \`Record<string, unknown>\`. It is a raw Envoy bootstrap fragment Control Plane passes through verbatim, and expanding it costs 81 property-type classes on \`gvc\` alone — more than four times every other shape in the lexicon combined — to type a field whose contents are Envoy's contract rather than Control Plane's.

Upstream reference: [docs.controlplane.com/reference](https://docs.controlplane.com/reference/api).
`;

const linksPage = `Control Plane addresses resources by **link**. Pass a declared resource where a link is expected and the serializer emits the right one for its kind:

\`\`\`typescript
export const identity = new Identity({ name: "web-identity", gvc: "prod" });

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: { identityLink: identity },   // → //gvc/prod/identity/web-identity
});
\`\`\`

## Why this matters more than usual

The identity form is a documented silent failure. A policy binding written against \`//identity/NAME\` — which reads perfectly naturally, and is what most people guess — is **accepted by the API and then ignored**. The policy exists, the binding exists, and the permission is never granted. Only \`//gvc/GVC/identity/NAME\` works.

Passing the resource means never having to remember that. [CPL013](/chant/lexicons/cpln/lint-rules/) catches it when you write the string by hand.

## Link forms

| Kind | Link |
|---|---|
| GVC | \`//gvc/NAME\` |
| Workload / Identity / VolumeSet | \`//gvc/GVC/<kind>/NAME\` |
| Secret / Policy / Domain / IpSet | \`//<kind>/NAME\` |
| Location | \`/org/ORG/location/<provider>-<region>\` |
| This org's image | \`//image/NAME:TAG\` |

## Runtime URIs are not links

\`cpln://secret/NAME.FIELD\` and \`cpln://volumeset/NAME\` are resolution URIs the container reads at runtime, not references between resources. They have no reference form, and [CPL002](/chant/lexicons/cpln/lint-rules/) leaves them alone.

## Attribute references do not serialize

There is no template-time reference language in a Control Plane manifest, so a value known only after apply cannot be embedded in one. Referencing an attribute is a build error with an explanation rather than a manifest that silently contains the wrong thing.
`;

const compositesPage = `Five composites, each encoding rules that are easy to violate by omission rather than by writing something wrong.

## \`GvcEnvironment\`

A GVC with its locations and pull secrets.

\`\`\`typescript
export const { gvc } = GvcEnvironment({
  name: "prod",
  org: "acme",
  locations: ["aws-us-east-1", "gcp-us-central1"],
  pullSecrets: ["registry-creds"],
});
\`\`\`

Pull secrets are **GVC-level**, not per workload — looking for them on a workload is a common wrong turn. Location ids are validated against the \`<provider>-<region>\` form before they become links.

## \`ServerlessService\`

A serverless workload with the port, firewall and autoscaling a public HTTP service needs. Serverless must expose exactly one HTTP port, and the external firewall starts closed in both directions, so a workload that looks entirely correct serves nothing until a CIDR is added.

## \`CronJob\`

A scheduled workload. It has no knobs for probes, autoscaling or \`timeoutSeconds\` — cron accepts all three and ignores them, so offering them would invite a silent no-op.

## \`StatefulService\`

A stateful workload and its volume set, mounted. Validates the performance class capacity floor at build time — \`high-throughput-ssd\` has a 200 GB minimum where the others have 10 GB — because \`fileSystemType\` and \`performanceClass\` are both immutable and correcting either later means data loss.

## \`SecretAccess\`

The identity and policy a workload needs to read a secret, with the GVC-qualified principal link. Pairs with \`secretRef(name, field)\` for the reference itself.

\`\`\`typescript
export const { identity, policy } = SecretAccess({
  name: "web-identity",
  gvc: "prod",
  secrets: ["db-password"],
});
\`\`\`
`;

const secretsPage = `Reading a secret at runtime takes three steps. **Missing any one fails silently at runtime** — the API accepts the broken form, the workload starts, and the failure surfaces later as an application error. Control Plane's own documentation calls a partial version of this its number one support issue.

1. The workload has an identity (\`spec.identityLink\`).
2. A policy grants that identity \`reveal\` on the secret, naming it as \`//gvc/GVC/identity/NAME\`.
3. The reference is field-qualified: \`cpln://secret/NAME.payload\`, not \`cpln://secret/NAME\`.

\`SecretAccess\` owns steps 1 and 2; \`secretRef()\` owns step 3.

## Field qualifiers by type

| Type | Field |
|---|---|
| \`opaque\` | \`.payload\` |
| \`dictionary\` | \`.KEY\` — one env var per key, or volume-mount as a directory |
| \`userpass\` | \`.username\`, \`.password\` |
| \`tls\` | \`.cert\`, \`.key\` |
| \`keypair\` | \`.publicKey\`, \`.privateKey\` |
| \`aws\` | \`.accessKey\`, \`.secretKey\`, \`.roleArn\` |
| \`gcp\` | unqualified — conventionally a volume-mounted JSON file |

## Identities

GVC-scoped and **not shareable** — declare one per GVC with the same spec. A workload has at most one. Do not assign one unless the workload needs secret access, credential-free cloud access, or private networking: an empty assignment complicates audit traces for no benefit.

## Values in source

Never. CPL001 fires on recognisable credential shapes at author time, where the finding has a file and a line and the credential has not yet reached git history; CPL012 catches the rest from the model. Read the value from the environment at build time, or set it out of band with \`cpln secret edit\` and let chant manage only the secret's existence and type.
`;

const adoptionPage = `## Live observation

\`describeResources()\` reads the live org and reports what each declared resource actually looks like, which is what \`chant plan\` diffs against.

\`\`\`bash
CPLN_ORG=acme CPLN_TOKEN=$(cat sa-key) chant plan
\`\`\`

Use the env var rather than \`--token\`: the flag leaks into process listings and logs, and Control Plane's own guidance says so.

The read is a lookup, not a fetch. Control Plane exposes an **org-wide rollup** for the GVC-scoped kinds (\`/org/{org}/workload\` alongside \`/org/{org}/gvc/{gvc}/workload\`), so each declared kind is listed once and indexed — one request per kind, rather than one per resource or one per GVC. No secret value is read on this path; \`-reveal\` is never called.

## Ownership

Every kind carries a free-form \`tags\` map, and every read path returns it, so chant's marker resolves on the thin read:

| Key | Value |
|---|---|
| \`chant.intentius.io/managed-by\` | \`chant\` |
| \`chant.intentius.io/stack\` | the stack name |
| \`chant.intentius.io/env\` | the environment, when set |

That is what lets \`chant delete\` be precise without an authoritative state file: a resource carrying the marker is this stack's; one without it is never auto-deleted. It is a cleaner channel than most targets offer — aws's thin read returns no tags at all and can only answer \`unknown\`.

Ownership means *carries chant's marker*, not *carries only chant's marker*, so co-stamping with other tooling is fine.

## The live graph

\`chant graph --live\` reconstructs edges from observed resources. Control Plane links are strings and edge matching is exact, so \`describeResources\` resolves each link down to the bare name it ends in and files it under \`refs.*\` — \`refs.gvc\`, \`refs.identity\`, \`refs.pullSecrets\`. GVC membership is modelled as containment, so the renderer draws a box rather than a line from every resource to its GVC.
`;

const applyingPage = `\`chant build\` emits one multi-document YAML file for \`cpln apply\`.

\`\`\`yaml
kind: gvc
name: prod
tags:
  chant.intentius.io/managed-by: chant
spec:
  staticPlacement:
    locationLinks:
      - /org/acme/location/aws-us-east-1

---
kind: workload
name: web
gvc: prod
tags:
  chant.intentius.io/managed-by: chant
spec:
  type: serverless
  containers:
    - name: main
      image: nginx:1.27
\`\`\`

Apply it:

\`\`\`bash
cpln apply --file dist/cpln.yaml --ready
\`\`\`

## Notes on the output

**Only authoring surface is emitted.** Control Plane's guidance is to export with \`-o yaml-slim\` rather than \`-o yaml\` before re-applying, because the server-side fields (\`status\`, \`id\`, \`created\`, \`lastModified\`, \`links\`) break \`cpln apply\`. Those are attributes in this lexicon rather than properties, so they never reach a document — the shape you can declare is already the slim shape.

**Ordering is resolved by \`cpln apply\`** for a multi-document file, so a single apply call is preferred over several sequential ones. Documents are still emitted GVC-first and sorted within a kind, so the file diffs cleanly between builds.

**\`--ready\` does not fail fast** on terminal container errors — a non-zero exit, an image pull failure, a crashloop. On a misconfigured first deploy it sits through its full timeout while the container is dead. For first deploys and workload type migrations, Control Plane documents a patience-windowed pattern instead.
`;

const workloadTypesPage = `Workload \`type\` is **immutable** — changing it means delete and recreate — and almost every other workload constraint follows from it.

| | Serverless | Standard | Stateful | Cron |
|---|:---:|:---:|:---:|:---:|
| Ports | exactly 1 HTTP | 0 or more | 0 or more | none |
| Scale to zero | \`rps\` / \`concurrency\` | KEDA only | KEDA only | no |
| Persistent volumes | no | no | yes | no |
| Multi-metric autoscaling | no | yes | yes | n/a |
| \`spec.job\` | forbidden | forbidden | forbidden | required |

## Resources

Defaults are \`cpu: 50m\`, \`memory: 128Mi\`. CPU ≥ 25m, memory ≥ 32Mi, and **\`memory(MiB) / cpu(millicores)\` ≤ 8** — so \`2Gi\` needs at least 256m of CPU. A memory-heavy, CPU-light workload is rejected, which surprises people coming from Kubernetes where the two are independent. The \`cpln/relaxMemoryToCpuRatio\` tag raises the ceiling to 32.

## Capacity AI

On by default for serverless, standard and cron. Mutually exclusive with CPU-utilization autoscaling, multi-metric autoscaling, and GPUs — all three for the same reason: they need a stable resource baseline that Capacity AI is actively moving. These conflicts are usually reached by *adding* CPU scaling or a GPU to a workload that never opted in, which is why [CPL027](/chant/lexicons/cpln/lint-rules/) says which of the two it is.

## Scale to zero

\`minScale: 0\` is accepted on any type and only takes effect for serverless under \`rps\`/\`concurrency\`, or standard/stateful under KEDA (which must be enabled on the GVC first). Everywhere else the workload holds at one replica and the saving never arrives, with nothing reported.

## Storage

\`ext4\` and \`xfs\` are RWO and bind to exactly one **stateful** workload; \`shared\` is RWX, works with any type, and supports no snapshots. \`high-throughput-ssd\` has a 200 GB floor where the others have 10 GB. Both \`fileSystemType\` and \`performanceClass\` are immutable.
`;

const skillsPage = `The lexicon ships three agent skills, installed with \`chant skills install\`.

| Skill | Covers |
|---|---|
| \`chant-cpln\` | The kinds, GVC scoping, links, composites, and live state |
| \`chant-cpln-workloads\` | Workload types, autoscaling, Capacity AI, resources, probes, firewalls, images |
| \`chant-cpln-secrets\` | The three-step secret access path, identities, policies, and their silent failures |

Each is written around the same thing the lint rules are: the parts of Control Plane where the wrong choice is accepted and then quietly does nothing.
`;

/**
 * Generate the documentation site for the cpln lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "cpln",
    displayName: "Control Plane",
    description: "Control Plane (cpln) GVCs, workloads, identities and secrets as typed estate.",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/cpln/",
    overview,
    outputFormat,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    extraPages: [
      {
        slug: "resources",
        title: "Resources",
        description: "The eight Control Plane kinds the lexicon declares, and what is not modelled.",
        content: resourcesPage,
      },
      {
        slug: "workload-types",
        title: "Workload Types",
        description: "Serverless, standard, stateful and cron — and the constraints each carries.",
        content: workloadTypesPage,
      },
      {
        slug: "links",
        title: "Links and References",
        description: "How Control Plane addresses resources, and why passing the resource beats writing the string.",
        content: linksPage,
      },
      {
        slug: "secrets",
        title: "Secrets and Identities",
        description: "The three-step secret access path and its silent failures.",
        content: secretsPage,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "GvcEnvironment, ServerlessService, CronJob, StatefulService, SecretAccess.",
        content: compositesPage,
      },
      {
        slug: "applying",
        title: "Applying",
        description: "What the serializer emits and how to apply it.",
        content: applyingPage,
      },
      {
        slug: "adoption",
        title: "Drift and Ownership",
        description: "Live observation, the tags ownership channel, and the live graph.",
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
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ` +
        `${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
