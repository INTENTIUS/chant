/**
 * chant #1984 — the enumerated set of modules that may reach the network, and
 * the scanner that keeps the enumeration honest.
 *
 * The problem this module exists to solve is drift. A prose audit of "what
 * does chant talk to" answers the question once and is wrong after the next
 * PR that adds a `fetch`. So the catalogue is not prose: it is
 * {@link EGRESS_CATALOGUE}, checked from three sides by
 * `test/no-egress.test.ts`.
 *
 *  1. **Closure.** {@link scanEgressSites} walks `packages/`, `lexicons/`,
 *     `scripts/` and `ops/` for modules that name a network primitive. Every
 *     file it finds must be in the catalogue and every catalogue entry must
 *     still be found, so an added `fetch` fails CI and a removed one fails CI
 *     too — the list can neither grow silently nor rot.
 *  2. **Accuracy.** Each entry declares which primitives it reaches for, and
 *     the scan must agree. An entry that says `fetch` and has quietly moved to
 *     a raw socket fails.
 *  3. **Publication.** {@link renderEgressCatalogueBlock} renders the docs
 *     table, and the committed page must match byte for byte. The page cannot
 *     drift from the catalogue because it is generated from it
 *     (`scripts/generate-egress-catalogue.ts`).
 *
 * What the catalogue rows are: modules that call a network primitive
 * *directly*. Indirection is deliberately not a row — `chant vendor` and every
 * lexicon's `spec/fetch.ts` reach the network through
 * `packages/core/src/codegen/fetch.ts`, which is the row, and the callers are
 * named in that row's reason. Rows-are-primitives is what makes the set
 * mechanically closed; a transitive-callers list would be a second thing to
 * maintain by hand, which is the failure mode this file exists to avoid.
 *
 * Same shape as `examples/fold-coverage.ts` (chant #1062): one render
 * function, one guard test asserting the committed doc matches it, and one
 * script that rewrites the doc on purpose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * Which chant phase reaches a catalogued module. The phase, not the file, is
 * what an adopter asking "can I run this air-gapped" actually needs.
 */
export type EgressPhaseId = "apply" | "emulator" | "codegen" | "audit" | "maintenance";

export interface EgressPhase {
  id: EgressPhaseId;
  /** Heading used for this phase's section in the generated docs table. */
  label: string;
  /** What reaches it, and why that is not a hidden dependency. */
  summary: string;
}

export const EGRESS_PHASES: readonly EgressPhase[] = [
  {
    id: "apply",
    label: "Reading and changing an estate",
    summary:
      "`chant lifecycle diff --live`, `plan`, `snapshot`, `apply`, `converge`, `chant search --live`, `chant import --live`, `chant run` and every component verb talk to the substrate they manage. This is the provider API, not a chant service — the same endpoint a console session or an SDK call would use, with the same credentials.",
  },
  {
    id: "emulator",
    label: "Local emulators",
    summary:
      "`chant emulator up` pulls a container image and then polls the container it just started on localhost. The poll is loopback traffic; the image pull is the container runtime's, and is the only egress in the phase.",
  },
  {
    id: "codegen",
    label: "Code generation",
    summary:
      "`chant dev generate`, `chant dev pinned-upgrade` and `chant vendor` fetch upstream schemas. Every lexicon's `spec/fetch.ts` runs here and nowhere else: the generated types and the committed spec snapshot are what a build reads, so a machine that never runs codegen never needs the endpoints below. `chant dev pinned-upgrade` is the one command here that queries `api.github.com`, and it is a lexicon-maintainer command — it moves a pin in a lexicon's own source, and nothing on an adopter's build, lint or apply path calls it.",
  },
  {
    id: "audit",
    label: "Auditing a remote repository",
    summary:
      "`chant audit <url>` reads someone else's repository over a git host's API. Auditing a local path reaches nothing.",
  },
  {
    id: "maintenance",
    label: "Repository maintenance",
    summary:
      "Freshness checks that run in this repository's own CI, against `api.github.com`. Nothing here sits on a path an adopter runs — no CLI command reaches these modules.",
  },
];

// ── Phases with no egress at all ─────────────────────────────────────────────

export interface OfflinePhase {
  /** The command, as a reader would type it. */
  command: string;
  /** What it does without a network. */
  note: string;
  /**
   * Whether `test/no-egress.test.ts` drives this command over the corpus with
   * the network primitives replaced by throwing stubs. A `false` here is a
   * claim from the static scan alone and says so in the generated page.
   */
  guarded: boolean;
}

/**
 * The offline half. Every entry with `guarded: true` is executed by
 * `test/no-egress.test.ts` against a real corpus project, with
 * `net.Socket.prototype.connect` and `globalThis.fetch` replaced by throwing
 * stubs — so the claim is tested, not asserted.
 */
export const OFFLINE_PHASES: readonly OfflinePhase[] = [
  {
    command: "chant build",
    note: "Discovery, evaluation and serialization. No network in process. One declaration puts a network-reaching child on this path — `HelmRender` with a `repo`, which renders the chart at synthesis time; see the shell-outs below.",
    guarded: true,
  },
  {
    command: "chant build --fold",
    note: "The same, with modules reduced to values instead of executed. No network in process.",
    guarded: true,
  },
  {
    command: "chant build --sandbox",
    note: "Project code is evaluated in a child process instead. Neither process reaches the network.",
    guarded: true,
  },
  {
    command: "chant lint",
    note: "Declarative rules and post-synth checks, over the built documents. No network in process.",
    guarded: true,
  },
  {
    command: "chant scenario check",
    note: "Scenarios are evaluated against a fixture snapshot, which is what replaces the live read. A scenario whose `given` is `snapshot(env)` rather than a file first runs `git fetch` for the lifecycle branch — see the shell-outs below.",
    guarded: true,
  },
  {
    command: "chant search",
    note: "Answers from the declared graph. `--live` and `--at` are the flags that read an estate, and they land in the apply phase above.",
    guarded: true,
  },
  {
    command: "chant graph, describe, list",
    note: "Projections of the same built graph. `--live` again is the opt-in.",
    guarded: false,
  },
];

// ── Shell-outs on the offline paths ──────────────────────────────────────────

export interface ShellOut {
  /** What was spawned — a binary for `spawn`/`exec`, a module for `fork`. */
  binary: string;
  /** Which offline command spawns it. */
  from: string;
  /** What it is for, and whether it can reach a network. */
  note: string;
  /**
   * Whether this spawn happens on every run of the phase.
   *
   * A conditional shell-out depends on something outside the repository — the
   * binary being on `PATH`, a warm cache, a project declaring the feature that
   * needs it — so the guard permits it without requiring it. Marking it here
   * rather than leaving it implicit is what keeps the guard's outcome the same
   * on a runner that has the tool and one that does not: the unconditional
   * entries are the ones the guard insists it observed, so it can still never
   * pass vacuously.
   */
  conditional?: true;
  /** Whether the spawned process can itself reach a network. */
  reachesNetwork: boolean;
}

/**
 * The child processes the offline phases spawn. A guard that intercepts
 * in-process primitives says nothing about a child, so these are enumerated
 * rather than covered — the acceptance criterion in #1984 is that the test
 * names them rather than implying total coverage.
 *
 * `test/no-egress.test.ts` records every spawn the guarded phases make and
 * fails on a binary that is not listed here, so this list is closed the same
 * way the catalogue is.
 */
export const OFFLINE_SHELL_OUTS: readonly ShellOut[] = [
  {
    binary: "git",
    from: "chant lint",
    note: "`git check-ignore --stdin`, to drop ignored paths from the file scan. Local repository read; no remote.",
    reachesNetwork: false,
  },
  {
    binary: "child.mjs",
    from: "chant build --sandbox, chant lint --sandbox",
    note: "The esbuild-bundled sandbox child, forked under `process.execPath` with `--permission` and a closed environment (`PATH`, plus `CHANT_ENV` for the config child). Node's Permission Model has no network flag, so the child is bounded by what the bundle contains rather than by a kernel gate — see [Sandboxed Execution](/chant/architecture/sandbox/).",
    reachesNetwork: false,
  },
  {
    binary: "git",
    from: "chant scenario check",
    note: "`git remote` then `git fetch <remote> chant/lifecycle`, and only when a scenario's `given` is `snapshot(env)` rather than a fixture file. This one does reach the configured git remote — the same remote the repository is already cloned from.",
    conditional: true,
    reachesNetwork: true,
  },
  // This guard's first finding, tracked as chant #2035: the render store that
  // would let a hermetic build skip the fetch is only reachable through a
  // capability profile, and the corpus builds the fixture that needs it while
  // the helm lexicon's own example suite skips it for exactly this reason.
  // Enumerated here rather than fixed here.
  {
    binary: "helm",
    from: "chant build, on a project declaring HelmRender",
    note: "`helm version`, then `helm template <name> <chart> --include-crds [--repo <url> --version <v>]`. A `HelmRender` composite resolves at synthesis time, so a project that declares one puts a chart render on its build path. With `repo` set, helm fetches the chart from that repository — **this is the one build-path shell-out that reaches a network**, on first synth only: the rendered manifests are cached under `~/.chant/helm-renders/` and every later build reads the cache. A project declaring no `HelmRender` never spawns it.",
    conditional: true,
    reachesNetwork: true,
  },
];

// ── The catalogue ────────────────────────────────────────────────────────────

/**
 * A network primitive, as {@link scanEgressSites} labels it. `node:*` means a
 * client-side symbol from that builtin — `createServer` is not one, which is
 * why an in-process fake server is not a catalogue entry.
 */
export type EgressPrimitive =
  | "fetch"
  | "node:http"
  | "node:https"
  | "node:net"
  | "node:tls"
  | "node:dns"
  | "http-client-package";

export interface EgressSite {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Primitives this module reaches for. Must equal what the scanner finds. */
  primitives: readonly EgressPrimitive[];
  phase: EgressPhaseId;
  /** Where it dials. */
  destination: string;
  /** Why this egress exists, in one sentence. */
  why: string;
}

/**
 * Every module in `packages/`, `lexicons/`, `scripts/` and `ops/` that calls a
 * network primitive directly.
 *
 * Adding a row is the deliberate, reviewed act #1984 asks for. Adding a fetch
 * without a row fails `test/no-egress.test.ts`.
 */
export const EGRESS_CATALOGUE: readonly EgressSite[] = [
  // ── apply ──────────────────────────────────────────────────────────────────
  {
    file: "packages/core/src/cli/handlers/run.ts",
    primitives: ["node:net"],
    phase: "apply",
    destination: "the configured Temporal server's gRPC address",
    why: "`chant run --temporal` opens a TCP probe against the server address and retries until it answers, so a not-yet-ready cluster reports as a wait rather than as a client error.",
  },
  {
    file: "packages/core/src/components/verbs/cloud-executor.ts",
    primitives: ["node:net"],
    phase: "apply",
    destination: "a declared cluster member's bolt port",
    why: "The agnostic `wait-cluster-healthy` verb probes each member's port to decide quorum; injectable, so a test never opens a socket.",
  },
  {
    file: "packages/core/src/components/verbs/wait-verify.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the endpoint a component declares",
    why: "`wait-endpoint` and `health-gate` poll the deployed thing they were pointed at; the fetcher is injectable for the same reason.",
  },
  {
    file: "lexicons/aws/src/api/read-client.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "AWS Cloud Control and CloudFormation, or `AWS_ENDPOINT_URL`",
    why: "The aws lexicon's read transport, signed with SigV4 and retargetable at a local emulator; there is no AWS SDK in the tree.",
  },
  {
    file: "lexicons/aws/src/op/activities/aws-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "AWS Cloud Control, or `AWS_ENDPOINT_URL`",
    why: "`awsApply` writes the change set the plan produced, over the same transport the read client uses.",
  },
  {
    file: "lexicons/aws/src/receipt-store.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "AWS SSM Parameter Store, or `AWS_ENDPOINT_URL_SSM`",
    why: "Effect receipts are read before an effect step and written after it succeeds; the store is the aws implementation of core's injectable receipt seam.",
  },
  {
    file: "lexicons/aws/src/agentcore/trace-fetch.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Bedrock AgentCore",
    why: "`awsAgentCoreFetchTrace` pulls a session history and renders it as replay-trace text for a later cedar policy replay.",
  },
  {
    file: "lexicons/azure/src/api/read-client.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Azure Resource Manager, or a declared endpoint override",
    why: "The azure lexicon's read transport for observation and live import.",
  },
  {
    file: "lexicons/azure/src/op/activities/az-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Azure Resource Manager, or a declared endpoint override",
    why: "`azApply` performs ARM resource CRUD for the native local applier and for real subscriptions alike.",
  },
  {
    file: "lexicons/gcp/src/api/read-client.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Google Cloud REST APIs, or a declared endpoint override",
    why: "The gcp lexicon's read transport, resolving Config Connector kinds to their underlying REST resources.",
  },
  {
    file: "lexicons/gcp/src/op/activities/gcp-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Google Cloud REST APIs, or a declared endpoint override",
    why: "`gcpApply` performs the REST calls a Config Connector manifest implies.",
  },
  {
    file: "lexicons/cpln/src/api.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the Control Plane API, or a declared endpoint",
    why: "The cpln lexicon's read transport, injectable through `CplnHttp` so tests need no network.",
  },
  {
    file: "lexicons/fly/src/op/activities/fly-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the Fly Machines API, or `FLY_API_HOSTNAME` (the mudflaps emulator)",
    why: "`flyApply` creates, updates and destroys Machines; pointing it at the emulator is how the Fly tutorials run offline.",
  },
  {
    file: "lexicons/fly/src/op/activities/sprites.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the Sprites API, or `SPRITES_BASE_URL`",
    why: "Sprite lifecycle activities — create, exec, destroy — for the Sprites Ops.",
  },
  {
    file: "lexicons/fly/src/op/activities/sprite-fs.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the Sprites filesystem API, or `SPRITES_BASE_URL`",
    why: "Stages an input file into a sprite and reads a result out, without shelling it through `spriteExec`.",
  },
  {
    file: "lexicons/fountain/src/op/activities/fountain-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the fountain control-plane API, or a declared endpoint",
    why: "`fountainApply` performs the lexicon's resource CRUD.",
  },
  {
    file: "lexicons/render/src/op/activities/render-apply.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "the Render API",
    why: "`renderApply` performs the lexicon's resource CRUD.",
  },
  {
    file: "lexicons/k8s/src/op/activities/argo.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "an Argo CD server's API",
    why: "The Argo sync/wait activities drive an installed Argo CD rather than reimplementing it.",
  },
  {
    file: "lexicons/cedar/src/avp/client.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "Amazon Verified Permissions",
    why: "The AVP read transport, hand-rolled over the AWS JSON protocol for the same reason the aws lexicon is: no AWS SDK in a vendor-neutral lexicon's dependency tree.",
  },
  {
    file: "lexicons/temporal/src/op/activities/http-check.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "whatever URL the Op step declares",
    why: "`httpCheck` is a generic probe step — the URL is the caller's, and the activity has no default of its own.",
  },
  {
    file: "lexicons/temporal/src/op/activities/workflow-audit.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "`api.github.com`, or a declared GitHub host",
    why: "The workflow-audit activity resolves an action reference to a commit so a pipeline can assert what it actually ran.",
  },
  {
    file: "lexicons/temporal/src/op/activities/pipeline-audit.ts",
    primitives: ["fetch"],
    phase: "apply",
    destination: "a GitLab instance's API",
    why: "The pipeline-audit activity reads project and pipeline metadata for the same governance question on GitLab.",
  },

  // ── emulator ───────────────────────────────────────────────────────────────
  {
    file: "packages/core/src/op/emulator-lifecycle.ts",
    primitives: ["fetch"],
    phase: "emulator",
    destination: "the just-started emulator container on localhost",
    why: "The shared boot loop polls the container's health endpoint until it answers; loopback only, and the image pull it depends on is the container runtime's.",
  },

  // ── codegen ────────────────────────────────────────────────────────────────
  {
    file: "packages/core/src/codegen/fetch.ts",
    primitives: ["fetch"],
    phase: "codegen",
    destination: "the upstream schema URL a caller passes",
    why: "`fetchWithCache`/`fetchWithRetry` — the single transport under every lexicon's `spec/fetch.ts`, the k8s CRD loader, `chant vendor` and `chant dev pinned-upgrade`. Caches to disk, bounds each attempt, and falls back to the committed snapshot when the endpoint is unreachable.",
  },
  {
    file: "lexicons/aws/src/spec/fetch.ts",
    primitives: ["fetch"],
    phase: "codegen",
    destination: "the CloudFormation resource specification and Cloud Control schema endpoints",
    why: "The aws spec fetch follows redirects itself rather than going through the shared cache helper; run by `chant dev generate`, never by a build.",
  },
  {
    file: "lexicons/cpln/src/spec/snapshot-cli.ts",
    primitives: ["fetch"],
    phase: "codegen",
    destination: "the Control Plane OpenAPI document",
    why: "`just snapshot` refreshes the committed offline spec snapshot; run on a networked machine on purpose, and the snapshot is what everything else reads.",
  },
  {
    file: "lexicons/azure/scripts/fetch-quickstart-templates.ts",
    primitives: ["fetch"],
    phase: "codegen",
    destination: "the Azure quickstart-templates repository",
    why: "Builds the ARM fixture corpus the azure serializer is tested against; a maintainer script, not part of the lexicon's published surface.",
  },

  // ── audit ──────────────────────────────────────────────────────────────────
  {
    file: "packages/core/src/audit/fetch.ts",
    primitives: ["fetch"],
    phase: "audit",
    destination: "an allowlisted git host's API — GitHub, GitLab or Forgejo",
    why: "The only audit module that touches the network: `chant audit <url>` pulls candidate files so the auditor can run on a URL. Hosts are allowlisted, redirects refused, and file count, size, bytes and time all capped.",
  },

  // ── maintenance ────────────────────────────────────────────────────────────
  {
    file: "packages/core/src/op/emulator-freshness.ts",
    primitives: ["fetch"],
    phase: "maintenance",
    destination: "`api.github.com` release metadata",
    why: "Reports how far behind an emulator's pinned image is. Advisory, never gating, and reached only from `scripts/check-emulator-freshness.ts` — no CLI command calls it.",
  },
  {
    file: "scripts/dogwood-freshness.ts",
    primitives: ["fetch"],
    phase: "maintenance",
    destination: "`api.github.com` commit and tree metadata",
    why: "Compares the committed dogwood pin against upstream for `scripts/check-dogwood-freshness.ts`. The transport is injectable, which is why the comparison half is unit-tested without a network.",
  },
];

// ── The scanner ──────────────────────────────────────────────────────────────

/** Trees the scan covers. Everything shipped, plus this repository's own tooling. */
export const EGRESS_SCAN_ROOTS = ["packages", "lexicons", "scripts", "ops"] as const;

/**
 * Directories the scan does not descend into.
 *
 * `examples` is excluded because those trees are consumer application code —
 * an example's own webhook relay or Solr query client is the example's, not
 * chant's, and cataloguing them would bury the rows that matter. `generated`
 * and `dist` are build output. Test files are excluded by extension below, for
 * the same reason: a test is not a path an adopter runs, and a recording
 * fetch mock in one would read as a network caller.
 */
export const EGRESS_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "generated",
  "examples",
  "__fixtures__",
  "__snapshots__",
  "coverage",
  ".git",
]);

/** Client-side symbols per builtin. `createServer` is deliberately absent. */
const BUILTIN_EGRESS_SYMBOLS: Record<string, { primitive: EgressPrimitive; symbols: Set<string> | "any" }> = {
  "node:http": { primitive: "node:http", symbols: new Set(["request", "get", "Agent", "ClientRequest"]) },
  "node:https": { primitive: "node:https", symbols: new Set(["request", "get", "Agent", "ClientRequest"]) },
  "node:net": { primitive: "node:net", symbols: new Set(["connect", "createConnection", "Socket"]) },
  "node:tls": { primitive: "node:tls", symbols: new Set(["connect", "TLSSocket"]) },
  "node:dns": { primitive: "node:dns", symbols: "any" },
  "node:dns/promises": { primitive: "node:dns", symbols: "any" },
};

/** Third-party HTTP clients. None are dependencies today; importing one is the point of the check. */
const HTTP_CLIENT_PACKAGES = new Set(["undici", "axios", "got", "node-fetch", "ky", "superagent", "phin", "needle"]);

export interface ScannedSite {
  file: string;
  primitives: EgressPrimitive[];
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EGRESS_SCAN_SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(m?ts|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.m?ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments removed; string and template contents preserved (import specifiers live there). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Comments, strings and template literals blanked. Init templates and docs
 * embed `fetch(...)` as string content; without this the scan would report the
 * module that *describes* a fetch alongside the one that performs it.
 */
function blankLiterals(source: string): string {
  return stripComments(source)
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/**
 * The global `fetch` used as a VALUE — `fetch(url)`, `?? fetch`, `= fetch`.
 * `typeof fetch` is excluded: a parameter typed as a fetch is indirection, and
 * the value still comes from whoever called it.
 */
const GLOBAL_FETCH = /(?<!typeof\s)(?<![.\w$])fetch(?![\w$])/;

const IMPORT_STATEMENT = /import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;

interface ImportBindings {
  named: string[];
  /** Namespace or default binding, if any — `import net from "node:net"`. */
  object?: string;
}

function parseImportClause(clause: string): ImportBindings {
  const bindings: ImportBindings = { named: [] };
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    for (const part of braced[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) bindings.named.push(name);
    }
  }
  const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/^type\s+/, "");
  const nsMatch = outside.match(/\*\s+as\s+([\w$]+)/);
  if (nsMatch) bindings.object = nsMatch[1];
  else {
    const defaultMatch = outside.match(/^\s*([\w$]+)\s*,?\s*$/);
    if (defaultMatch) bindings.object = defaultMatch[1];
  }
  return bindings;
}

/** The network primitives one module's source reaches for. */
export function egressPrimitivesIn(source: string): EgressPrimitive[] {
  const found = new Set<EgressPrimitive>();
  const code = blankLiterals(source);
  const withStrings = stripComments(source);

  if (GLOBAL_FETCH.test(code)) found.add("fetch");

  for (const match of withStrings.matchAll(IMPORT_STATEMENT)) {
    const specifier = match[2] ?? match[3];
    if (!specifier) continue;

    const bare = specifier.replace(/^node:/, "");
    if (HTTP_CLIENT_PACKAGES.has(bare) || HTTP_CLIENT_PACKAGES.has(specifier)) {
      found.add("http-client-package");
      continue;
    }

    const builtin = BUILTIN_EGRESS_SYMBOLS[specifier];
    if (!builtin) continue;
    if (builtin.symbols === "any") {
      found.add(builtin.primitive);
      continue;
    }
    const clause = match[1];
    if (clause === undefined) continue;
    const { named, object } = parseImportClause(clause);
    if (named.some((n) => (builtin.symbols as Set<string>).has(n))) {
      found.add(builtin.primitive);
      continue;
    }
    // A namespace or default import only counts when a client symbol is
    // actually reached through it — `http.createServer(...)` listens, it does
    // not dial.
    if (object) {
      for (const symbol of builtin.symbols as Set<string>) {
        if (new RegExp(`\\b${object}\\s*\\.\\s*${symbol}\\b`).test(code)) {
          found.add(builtin.primitive);
          break;
        }
      }
    }
  }

  return [...found].sort();
}

/** Every module under {@link EGRESS_SCAN_ROOTS} that reaches a network primitive. */
export function scanEgressSites(repoRoot: string): ScannedSite[] {
  const sites: ScannedSite[] = [];
  for (const root of EGRESS_SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const primitives = egressPrimitivesIn(readFileSync(file, "utf-8"));
      if (primitives.length > 0) {
        sites.push({ file: relative(repoRoot, file).split(sep).join("/"), primitives });
      }
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file));
}

// ── The generated docs block ─────────────────────────────────────────────────

// MDX parses `<` as the start of a tag, so an HTML comment fails to parse
// where this block lives. `{/* … */}` is MDX's own comment form.
export const EGRESS_CATALOGUE_START = "{/* GENERATED:egress-catalogue:start */}";
export const EGRESS_CATALOGUE_END = "{/* GENERATED:egress-catalogue:end */}";

/** Escape a table cell so a pipe in a reason never breaks the row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The whole marker-delimited section: the offline table, the shell-outs, and the catalogue by phase. */
export function renderEgressCatalogueBlock(): string {
  const lines: string[] = [EGRESS_CATALOGUE_START, ""];

  lines.push("## Phases with no egress", "");
  lines.push(
    "A guarded row is executed by `test/no-egress.test.ts` over every project in the example corpus, with `net.Socket.prototype.connect` and `globalThis.fetch` replaced by throwing stubs. Adding a network call to one of these paths fails that test.",
    "",
  );
  lines.push("| Command | Behaviour | Guarded by test |", "|---|---|---|");
  for (const phase of OFFLINE_PHASES) {
    lines.push(`| \`${cell(phase.command)}\` | ${cell(phase.note)} | ${phase.guarded ? "yes" : "static scan only"} |`);
  }
  lines.push("");

  lines.push("## Shell-outs on those paths", "");
  lines.push(
    "An in-process guard says nothing about a child process, so the offline phases' shell-outs are enumerated instead. The guard records every spawn and fails on a binary that is not listed here.",
    "",
    "**Reaches a network** is the column to read. Two of these do, and both are conditional — they need a declaration or a flag that a project either has or does not. Nothing else spawned on an offline path leaves the machine.",
    "",
  );
  lines.push("| Binary | Spawned by | Reaches a network | What it does |", "|---|---|---|---|");
  for (const shellOut of OFFLINE_SHELL_OUTS) {
    const reach = shellOut.reachesNetwork ? (shellOut.conditional ? "yes, conditionally" : "yes") : "no";
    lines.push(
      `| \`${cell(shellOut.binary)}\` | \`${cell(shellOut.from)}\` | ${reach} | ${cell(shellOut.note)} |`,
    );
  }
  lines.push("");

  lines.push("## Phases that do reach the network", "");
  for (const phase of EGRESS_PHASES) {
    const sites = EGRESS_CATALOGUE.filter((site) => site.phase === phase.id);
    lines.push(`### ${phase.label}`, "", phase.summary, "");
    lines.push("| Module | Primitive | Destination | Why |", "|---|---|---|---|");
    for (const site of sites) {
      lines.push(
        `| \`${cell(site.file)}\` | ${site.primitives.map((p) => `\`${cell(p)}\``).join(", ")} | ${cell(site.destination)} | ${cell(site.why)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    `**${EGRESS_CATALOGUE.length} modules** across ${EGRESS_SCAN_ROOTS.map((root) => `\`${root}/\``).join(", ")} call a network primitive directly. Every other module that reaches the network does so through one of them.`,
  );
  lines.push("", EGRESS_CATALOGUE_END);
  return lines.join("\n");
}

/** Extract the current marker-delimited block (markers included) from a doc's raw text. */
export function extractEgressCatalogueBlock(doc: string): string {
  const start = doc.indexOf(EGRESS_CATALOGUE_START);
  const end = doc.indexOf(EGRESS_CATALOGUE_END);
  if (start === -1 || end === -1) {
    throw new Error(
      `egress-catalogue markers not found — expected both "${EGRESS_CATALOGUE_START}" and "${EGRESS_CATALOGUE_END}" in the doc`,
    );
  }
  return doc.slice(start, end + EGRESS_CATALOGUE_END.length);
}

/** Replace the marker-delimited block in `doc` with a freshly rendered one. */
export function replaceEgressCatalogueBlock(doc: string): string {
  return doc.replace(extractEgressCatalogueBlock(doc), renderEgressCatalogueBlock());
}

/**
 * Every doc that publishes the catalogue, relative to the repo root. The list
 * is the contract: the generator refreshes each entry and the guard asserts
 * each entry, so a second page stating the same thing cannot go stale beside
 * the generated one.
 */
export const EGRESS_CATALOGUE_DOCS = ["docs/src/content/docs/reference/network-egress.mdx"] as const;
