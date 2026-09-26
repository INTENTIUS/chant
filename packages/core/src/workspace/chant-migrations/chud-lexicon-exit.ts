/**
 * `chud-lexicon-exit` (#2737, ws-056): take a repo made from chud's template,
 * or the studio kit's copy of it, off `@intentius/chant-lexicon-chud` and
 * `@intentius/chud-runtime`.
 *
 * ws-056 split the chud lexicon by the boundary. What is specification goes to
 * chant, and this migration moves it:
 *
 * - the decision points (`delivery/decisions/points.yaml`) become chant's
 *   points file, `decisions/points.json` at the workspace root, with each
 *   input named for the read-contract output it comes from, and an answer
 *   kind in `answers/` (ws-058, #2757, #2777);
 * - the release Op asks `ship-skip` through the systemone lexicon's `decide`
 *   activity (#2769), and its ship gate takes the point's quorum and the Cedar
 *   policy as before;
 * - the app component runs chant's own supply-chain verbs (SBOM, scan,
 *   vuln-gate) on the app member;
 * - the Fly site's resources stay on the fly lexicon, without chud's
 *   `FlySite` wrapper (#2736);
 * - the chud-runtime `upgrade` Op is replaced by `chant workspace upgrade`;
 * - CI no longer fetches the private runtime package.
 *
 * What is runtime goes to the studio kit (arugula-salad/studio, `template/`),
 * and is deleted here with a pointer: the dispatch Op (ws-057, studio#47), the
 * local site (the box's service), the write-scope policy and the
 * contract-sizing rules, and `chud dev` / `chud design` (hud on the box).
 *
 * chud's steps after the ship gate move to chant's (#2782): the release Op
 * archives the app member (`sourceArchive`), plans the release
 * (`releasePlan`), gates on the plan's digest, ships the approved tree to the
 * Fly Machine with the fly lexicon's `flyRelease` (each migration once per
 * environment, under a receipt), and records it in the release ledger with
 * its plan (`releaseRecord`). Signing the archive (#2515) and the rollback Op
 * (#2800) have no chant home yet: the rollback Op is deleted, and the plan
 * says so.
 *
 * Files are matched by what they hold, not by the template version the scope
 * is pinned at, so a repo from any chud template commit or the studio kit's
 * copy is planned alike. A file this migration replaces or deletes that was
 * edited since the template wrote it is still replaced or deleted, since it
 * could not build without the chud packages, and the plan marks it edited:
 * the edit is in git history. A file it only edits (chant.config.ts, ci.ts,
 * fly.ts, the Cedar policy, ci.yml) keeps the project's edits; an edit whose
 * anchor is gone is a conflict.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import yaml from "js-yaml";
import answerSchema from "../point-answer.schema.json";
import { fileHash } from "../lineage-lock";
import { DECISION_POINTS_SCHEMA_ID, POINT_INPUT_OUTPUT_NAMES, parsePoints, PointsError } from "../points";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, NotMoved, PlanConflict, PlannedChange } from "../chant-migrations";

export const CHUD_LEXICON_EXIT = "chud-lexicon-exit";

/** The two packages this migration takes a repo off. */
export const CHUD_PACKAGES = ["@intentius/chant-lexicon-chud", "@intentius/chud-runtime"] as const;

/** An import, export-from, require or dynamic import of either package, at any subpath. */
const CHUD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@intentius\/(?:chant-lexicon-chud|chud-runtime)(?:\/[^"']*)?["']/;

/** The studio kit's template, where the runtime half of chud's template lives. */
const KIT = "the studio kit (arugula-salad/studio, template/)";
/** Signing a source archive, and checking the signature before the Machine runs it. */
const SIGN_ISSUE = "INTENTIUS/chant#2515";
/** Rolling a Fly site shipped by the release Op back to its previous release. */
const ROLLBACK_ISSUE = "INTENTIUS/chant#2800";

/** Where each chud-only file of the delivery project went, relative to the delivery member. */
const DELETED: Array<{ path: string; why: string; notMoved?: NotMoved }> = [
  { path: "ops/dispatch.op.ts", why: "the dispatch Op is the kit's runtime (ws-057)", notMoved: { what: "the dispatch Op (ops/dispatch.op.ts) and `chud factory run`", where: `${KIT}: the runner and its dispatch Op (arugula-salad/studio#47); the dispatcher is a Steward (ws-057), and work leases are chant's (INTENTIUS/chant#2762)` } },
  { path: "ops/rollback.op.ts", why: "chud's site rollback has no chant home yet", notMoved: { what: "the rollback Op (ops/rollback.op.ts)", where: `${ROLLBACK_ISSUE}: \`chant components rollback\` over a release the release Op shipped` } },
  { path: "ops/upgrade.op.ts", why: "replaced by chant workspace upgrade" },
  { path: "ops/upgrade.mjs", why: "replaced by chant workspace upgrade" },
  { path: "ops/site.mjs", why: "npm run check runs the app's tests itself", notMoved: { what: "the approved contracts' checks in `npm run check` and the release's Check phase, and the evidence they record", where: `${KIT}: the development model's checks and evidence records` } },
  { path: "deploy/site.ts", why: "the local site is the box's service", notMoved: { what: "the local site (deploy/site.ts, ChudLocalSite under .chud/site)", where: `${KIT}: the box's service runs the app (ws-056)` } },
  { path: ".chant/policies/write-scope.ts", why: "the design app's write scope is the kit's", notMoved: { what: "the write-scope policy (CHUD-WRITE-SCOPE, the Chud-Author trailer)", where: `${KIT}: the design app's write scope; chud.protectedPaths stays in chant.config.ts for it` } },
  { path: ".chant/rules/contract-sizing.ts", why: "sizing work items is the kit's", notMoved: { what: "the contract-sizing lint rules (CHUD001, CHUD002, CHUD003)", where: `${KIT}: it sizes work items and supplies the slice-tier point's inputs` } },
];

/** How each of chud's points names its inputs in chant (the reference workspace's restatement, #2777). */
const POINT_OUTPUTS: Record<string, { output: string; rename?: Record<string, string> }> = {
  "slice-tier": { output: "work-item" },
  "ship-skip": { output: "release", rename: { contracts_changed: "work_changed" } },
};

const ANSWER_KIND = `// The answers to the workspace's decision points (ws-058), data only: no
// imports, no code.
//
// chant workspace points --open --json
// chant workspace points answer <id> --answer <answer> --by <name>
//
// The points are declared in ../decisions/points.json. Each answer is one
// record here, named for the point and its inputs' hash, so the same question
// is answered once. answer.schema.json is a copy of the one @intentius/chant
// ships as workspace/point-answer.schema.json.
//
// Written by \`chant workspace upgrade\` (its migration ${CHUD_LEXICON_EXIT}),
// when chud's delivery/decisions/points.yaml moved to chant's points file.
export const recordKind = {
  name: "answer",
  location: { dir: ".", match: "^[a-z][a-z0-9-]*-[0-9a-f]{12}\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:point-answer:1", path: "answer.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["escalated", "proposed", "answered"],
  closedStates: ["answered"],
  constrains: { field: "constrains" },
  source: { field: "source" },
  answers: { points: "../decisions/points.json" },
};
`;

function releaseOp(pointsRel: string, appRel: string): string {
  return `/**
 * Release: check what is committed on HEAD, plan it, stop at the ship gate,
 * and once the plan is approved, ship it to the Fly site and record it.
 *
 * \`chant workspace upgrade\` wrote this from chud's release Op, with chant's
 * own parts in place of the chud lexicon (its migration ${CHUD_LEXICON_EXIT}):
 *
 * - Check runs the app's own tests (\`appTest\` in chant.config.ts's
 *   buildParams) in the app member.
 * - Build archives the app member as committed on HEAD (\`sourceArchive\`,
 *   \`git archive\`: the same commit is always the same bytes, named by their
 *   sha256), and builds the Fly app's requests (\`npm run build:fly\`, from
 *   deploy/fly.ts and deploy/fly-machine.ts, into dist/fly.json).
 * - Plan asks the ship-skip point, declared in decisions/points.json at the
 *   workspace root, through the systemone lexicon's \`decide\` activity, and
 *   writes the release plan: the archive's digest, the commit, and the
 *   point's answer, named by the sha256 of its own content. Its table says no
 *   to every release until someone adds a row, and each answer is a record in
 *   answers/. An open question stops the run \`waiting\` until a person answers
 *   it (\`chant workspace points --open\`).
 * - The \`ship\` gate approves that plan's digest: \`chant approve release ship
 *   --plan <digest>\`. Its approver count is the point's quorum, and every
 *   approval is put to the Cedar policy in decisions/ship-skip.cedar.ts, with
 *   the point's answer and the decider that gave it. The policy runs
 *   \`log-only\`: its decision is recorded on each approval, and only people
 *   pass the gate. A run whose plan differs (another commit, another answer)
 *   is refused by name.
 * - Ship runs the fly lexicon's \`fly-release\` steps for the \`fly\`
 *   environment: the archive is read only if its bytes still hash to the
 *   planned digest, and its files go onto the declared Machine under
 *   /srv/app with \`appStart\` as its command; each migration in the app's
 *   migrations folder runs once per environment inside the Machine, under a
 *   receipt in chant's lifecycle receipt store; then the Machine must be
 *   started with this release (and healthy at \`chud.sites.fly.url\` when set).
 *   A failure after the Machine changed puts back what it served before.
 * - Record appends the release to the \`fly\` release ledger with its plan
 *   (ws-055), and the gate's approver.
 *
 * A retry is safe: the same commit plans the same digest, so its approval
 * holds; the Machine already serving it is left as it is, every migration's
 * receipt matches, and the ledger is written once.
 *
 * Not yet chant's: signing the archive and checking the signature before the
 * Machine runs it (${SIGN_ISSUE}), and rolling the site back to the previous
 * release (${ROLLBACK_ISSUE}). The local site is the studio kit's box service
 * (arugula-salad/studio, template/), and so are the approved contracts'
 * checks and their evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Op, phase, gate, shell, build, sourceArchive, releasePlan, releaseRecord } from "@intentius/chant/op";
import { parsePoints, quorumOf } from "@intentius/chant/workspace/points";
import { decide } from "@intentius/chant-lexicon-systemone";
import { flyRelease } from "@intentius/chant-lexicon-fly";
import project from "../chant.config.ts";
import { shipSkipPolicy } from "../decisions/ship-skip.cedar.ts";

/** The environment this Op ships to: the Fly app deploy/fly.ts declares. */
const ENV = "fly";
/** Where the release's files go on the Machine. */
const INTO = "/srv/app";
const params = project.buildParams;
/** The Fly site's public URL, when chant.config.ts gives one: the release is verified at its health endpoint too. */
const siteUrl = (project as { chud?: { sites?: { fly?: { url?: string } } } }).chud?.sites?.fly?.url;

const pointsFile = fileURLToPath(new URL(${JSON.stringify(pointsRel)}, import.meta.url));
const shipSkipPoint = parsePoints(readFileSync(pointsFile, "utf-8"), pointsFile)["ship-skip"];

/** The migrations committed on HEAD, in order, each with the sha256 of its content. */
function migrations() {
  const appDir = fileURLToPath(new URL(${JSON.stringify(`../${appRel}/`)}, import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf-8" });
  const dir = params.appMigrations.default;
  return git("ls-tree", "--name-only", "HEAD", \`\${dir}/\`)
    .split("\\n")
    .filter((path) => path.endsWith(".sql"))
    .sort()
    .map((path) => {
      const name = path.slice(dir.length + 1);
      return {
        name,
        command: \`cd \${INTO} && \${params.appMigrate.default} \${name}\`,
        sha: \`sha256:\${createHash("sha256").update(git("show", \`HEAD:./\${path}\`)).digest("hex")}\`,
      };
    });
}

const shipSkip = decide("ship-skip", { id: "shipSkip" });
const archive = sourceArchive(${JSON.stringify(appRel)}, { id: "archive" });
const plan = releasePlan({
  id: "plan",
  component: "app",
  env: ENV,
  gitSha: archive.out.commit,
  content: {
    artifact: { kind: "source-tree", digest: archive.out.digest, dir: archive.out.dir },
    shipSkip: { answer: shipSkip.out.answer, decider: shipSkip.out.decider },
  },
});

export default Op({
  name: "release",
  overview: \`Check HEAD of \${params.name.default}, plan it, and ship it to Fly once the plan is approved.\`,
  phases: [
    phase("Check", [shell(params.appTest.default, { cwd: ${JSON.stringify(appRel)} })]),
    phase("Build", [archive, build(".", { script: "build:fly" })]),
    phase("Plan", [shipSkip, plan]),
    phase("Gate", [
      gate("ship", {
        plan: plan.out.digest,
        description: \`Ship \${params.name.default} to \${ENV}\`,
        approval: {
          quorum: quorumOf(shipSkipPoint),
          policy: shipSkipPolicy,
          mode: "log-only",
          context: { shipSkip: shipSkip.out.answer, shipSkipBy: shipSkip.out.decider },
        },
      }),
    ]),
    phase("Ship", [
      flyRelease({
        environment: ENV,
        component: "app",
        plan: "dist/fly.json",
        digest: plan.out.digest,
        gitSha: archive.out.commit,
        source: { archive: archive.out.archive, digest: archive.out.digest, dir: archive.out.dir, into: INTO, start: params.appStart.default },
        migrations: migrations(),
        verify: { url: siteUrl, healthPath: params.appHealth.default },
      }),
    ]),
    phase("Record", [releaseRecord({ plan: plan.out.file, digest: plan.out.digest, approval: { op: "release", gate: "ship" } })]),
  ],
});
`;
}

function appComponent(appRel: string): string {
  return `/**
 * The app, as a chant component. \`chant list --components\` and \`chant
 * describe app --components\` show it, and \`chant run --components app\` runs
 * its supply chain: the app member's SBOM, its scan, and chant's vuln-gate,
 * which fails the run, listing the blocking findings, when the SBOM violates
 * \`vulnPolicy\` in chant.config.ts.
 *
 * \`chant workspace upgrade\` wrote this from chud's app component (its
 * migration ${CHUD_LEXICON_EXIT}). chud built the app into an archive, signed
 * it and shipped it to a site with the chud lexicon's steps. The release Op
 * (ops/release.op.ts) does the shipping now: it archives the app member,
 * plans and gates the release, and puts it on the Fly Machine with the fly
 * lexicon's \`fly-release\` steps, so this component publishes nothing and
 * records no release. The local site is the studio kit's box service
 * (arugula-salad/studio, template/), and the Fly site's resources stay in
 * fly.ts and fly-machine.ts.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { generateSbom, scanVulnerabilities, vulnGate } from "@intentius/chant/components/builders";
import { resolveSbomFormat, resolveVulnPolicy } from "@intentius/chant/config";
import project from "../chant.config.ts";

export const app: Component = {
  name: "app",
  archetype: "service",
  dependsOn: [],
  deploy: [
    phase("SBOM", [generateSbom({ artifactType: "dir", path: ${JSON.stringify(appRel)}, format: resolveSbomFormat(project) })]),
    phase("Scan", [
      scanVulnerabilities({ sbom: "@SBOM.sbom" } as never),
      // chant's gate: throws, listing the blocking findings, when the SBOM violates the policy.
      vulnGate({ sbom: "@SBOM.sbom", findings: "@Scan.findings", policy: resolveVulnPolicy(project) } as never),
    ]),
  ],
};
`;
}

/** A scope file as text, or undefined. */
function readText(dir: string, path: string): string | undefined {
  const abs = join(dir, path);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
}

// ── Text edits ───────────────────────────────────────────────────────────────

interface Edit {
  find: string | RegExp;
  replace: string;
  /** A required edit whose anchor is missing, while `unless` does not match, is a conflict. */
  required?: string;
  /** The edit is not needed when the text matches this (already done, or never there). */
  unless?: RegExp;
}

function applyEdits(text: string, edits: Edit[]): { text: string; missing: string[] } {
  const missing: string[] = [];
  for (const e of edits) {
    if (e.unless?.test(text)) continue;
    const hit = typeof e.find === "string" ? text.includes(e.find) : e.find.test(text);
    if (!hit) {
      if (e.required) missing.push(e.required);
      continue;
    }
    text = typeof e.find === "string" ? text.split(e.find).join(e.replace) : text.replace(e.find, e.replace);
  }
  return { text, missing };
}

const CONFIG_HEADER_OLD = /\/\/ The workspace's chant project \(the `delivery` member[\s\S]*?\/\/ no limit\. The design app reads the same options, so it warns alike\.\n/;
const CONFIG_HEADER_NEW = `// The workspace's chant project (the \`delivery\` member of chant.workspace.json;
// the app is the \`app\` member, and the development model's records are the
// \`design\` member). The fountain lexicon for the agents in agents/, the Ops in
// ops/ (found by their *.op.ts names), the fly lexicon for the Fly app
// (deploy/fly.ts), the cedar lexicon for the ship gate's approval policy
// (decisions/ship-skip.cedar.ts), and the systemone lexicon for the release
// Op's \`decide\` step, which asks the ship-skip decision point in
// decisions/points.json at the workspace root. The github lexicon is for this
// repo's CI (ci/ci.ts), which \`npm run ci:build\` writes to
// .github/workflows/ci.yml. The app is a chant component
// (deploy/app.component.ts); \`sourceDir\` is where chant finds it, so
// \`chant list --components\` and \`chant components status --live\` read
// deploy/.
//
// \`chant workspace upgrade\` took this project off the chud lexicon (its
// migration ${CHUD_LEXICON_EXIT}). The \`chud\` block below is data the studio
// kit reads (arugula-salad/studio, template/): the design app's protected
// paths, the sites, and the issue its decision records cite.
`;

function configEdits(): Edit[] {
  return [
    { find: "lexicons:", replace: "lexicons:", required: "the `lexicons` list" },
    {
      find: /\n  lint: \{\n    rules: \{\n      CHUD001: \["warning", sizing\],\n      CHUD002: \["warning", sizing\],\n    \},\n    \/\/ CHUD-WRITE-SCOPE: the release plan runs it \(through `chant build`\) over\n    \/\/ the commits it would ship\. See the file\.\n    policies: \["\.chant\/policies\/write-scope\.ts"\],\n  \},/,
      replace: "",
      required: "the `lint` block naming CHUD001, CHUD002 and the write-scope policy",
      unless: /^(?![\s\S]*(?:CHUD00[123]|write-scope\.ts))/,
    },
    { find: CONFIG_HEADER_OLD, replace: CONFIG_HEADER_NEW },
    {
      find: "// migrate and test the app. chud (and @intentius/chud-runtime) reads them from\n// here.",
      replace: "// migrate and test the app. The release Op and the studio kit's box read them\n// from here.",
    },
    {
      find: "  // Where releases ship: prod, the local site under .chud/site, and fly, a Fly\n  // app (deploy/fly.ts). `npm run release` ships to prod; `npm run release --\n  // --env fly` to fly, with FLY_API_TOKEN set (FLY_FLAPS_BASE_URL points it at\n  // mudflaps, the Machines API emulator, instead of Fly).\n",
      replace: "  // The environments: prod, the local site (the studio kit's box), and fly, the\n  // Fly app (deploy/fly.ts). `npm run release` ships to fly once its plan is\n  // approved (ops/release.op.ts), with FLY_API_TOKEN set (FLY_FLAPS_BASE_URL\n  // points it at mudflaps, the Machines API emulator, instead of Fly).\n",
    },
  ];
}

/** The `lexicons` list without "chud" and with "systemone", and no `sizing` const once nothing reads it. */
function fixConfig(text: string): string {
  text = text.replace(/lexicons:\s*\[([^\]]*)\]/, (_all, inner: string) => {
    const names = [...inner.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).filter((n) => n !== "chud");
    if (!names.includes("systemone")) names.push("systemone");
    return `lexicons: [${names.map((n) => JSON.stringify(n)).join(", ")}]`;
  });
  const sizing = /const sizing = \{\n  small: \{[^\n]*\},\n  medium: \{[^\n]*\},\n\};\n\n/;
  const without = text.replace(sizing, "");
  return without !== text && !/\bsizing\b/.test(without) ? without : text;
}

const FLY_EDITS: Edit[] = [
  {
    find: /import \{ FlySite \} from "@intentius\/chud-runtime\/lexicon";\n/,
    replace: "",
    required: "the FlySite import from @intentius/chud-runtime/lexicon",
    unless: /^(?![\s\S]*FlySite)/,
  },
  {
    find: /\n(?:\/\*\*[^\n]*\*\/\n)?export const flySite = new FlySite\([^\n]*\);\n/,
    replace: "\n",
    required: "the flySite declaration",
    unless: /^(?![\s\S]*new FlySite\()/,
  },
  {
    find: /\(@intentius\/chud-runtime's fly-site\.mjs\)/g,
    replace: "(the release Op's Ship phase, ops/release.op.ts)",
  },
];

const FLY_MACHINE_EDITS: Edit[] = [
  {
    find: /\(@intentius\/chud-runtime's fly-site\.mjs\)/g,
    replace: "(the release Op's Ship phase, ops/release.op.ts)",
  },
];

const CEDAR_EDITS: Edit[] = [
  {
    find: `const tableSaysYes = 'context has shipSkip && context.shipSkip == "yes by table"';`,
    replace: `const tableSaysYes = 'context has shipSkip && context has shipSkipBy && context.shipSkip == true && context.shipSkipBy == "table"';`,
    required: "the tableSaysYes condition over chud's `said` string",
    unless: /^(?![\s\S]*"yes by table")/,
  },
  {
    find: " * `PassGate` request: the principal is `Chant::Human::\"<approver>\"` or, with\n * `--agent` (or over MCP/ACP), `Chant::Agent::\"<name>\"`. Its context is the\n * plan digest and `shipSkip`, the answer to the ship-skip decision point in\n * decisions/points.yaml as the release plan recorded it: `no by table`,\n * `yes by table`, `yes by model`, `escalated to quorum`, ...",
    replace: " * `PassGate` request: the principal is `Chant::Human::\"<approver>\"` or, with\n * `--agent` (or over MCP/ACP), `Chant::Agent::\"<name>\"`. Its context holds\n * `shipSkip`, the answer to the ship-skip decision point in the workspace's\n * decisions/points.json (true or false), and `shipSkipBy`, the decider that\n * gave it: `table`, `model` or `quorum`.",
  },
];

const CI_TS_EDITS: Edit[] = [
  {
    find: /\n\/\/ @intentius\/chud-runtime is installed from a private GitHub repo[\s\S]*?\/\/ With neither set, `npm ci` installs only what it can reach without them\.\n/,
    replace: "\n",
  },
  {
    find: /\/\/ npm installs a github: dependency over ssh[\s\S]*?\]\.join\("\\n"\);\n\n/,
    replace: "",
    required: "the runtimeAccess script",
    unless: /^(?![\s\S]*const runtimeAccess)/,
  },
  {
    find: /    new Step\(\{\n      name: "Read access to @intentius\/chud-runtime",\n[\s\S]*?\n      run: runtimeAccess,\n    \}\),\n/,
    replace: "",
    required: "the \"Read access to @intentius/chud-runtime\" step",
    unless: /^(?![\s\S]*Read access to @intentius\/chud-runtime)/,
  },
  { find: "import { Workflow, Job, Step, Checkout, SetupNode, secrets } from", replace: "import { Workflow, Job, Step, Checkout, SetupNode } from", unless: /secrets\(/ },
  {
    find: "then `npm run check`: the\n// app's own tests and every approved contract's check, run by\n// @intentius/chud-runtime the way a release's Check phase runs them (records\n// valid, approved contracts unchanged since approval), without recording\n// evidence.",
    replace: "then `npm run check`: the\n// app's own tests. The approved contracts' checks are the studio kit's.\n//",
  },
  { find: "/** The delivery member, where chant, its lexicons and the runtime are installed. */", replace: "/** The delivery member, where chant and its lexicons are installed. */" },
  { find: `name: "App tests and approved contract checks"`, replace: `name: "App tests"` },
];

const CI_YML_EDITS: Edit[] = [
  {
    find: /      - name: Read access to @intentius\/chud-runtime\n(?: {8,}[^\n]*\n)+/,
    replace: "",
    required: "the \"Read access to @intentius/chud-runtime\" step",
    unless: /^(?![\s\S]*Read access to @intentius\/chud-runtime)/,
  },
  { find: "      - name: App tests and approved contract checks\n", replace: "      - name: App tests\n" },
];

// ── Root prose (#2805): README.md, CLAUDE.md and design/CLAUDE.md still
// describe what this migration deletes. Each edit's `unless` marker is text
// the replacement drops, so a second upgrade (or a template that never had
// the passage) finds nothing to do.

const README_EDITS: Edit[] = [
  {
    find: "| delivery | [`delivery/`](delivery) | `chant` | the chant project, which still runs on chud's runtime package (`@intentius/chud-runtime`) and the chud lexicon until they are split out of chud (INTENTIUS/chant#2713): the release, rollback, upgrade and dispatch Ops, the sites releases ship to, the agents that build the app, the decision points, the write-scope policy and this repo's CI |",
    replace:
      "| delivery | [`delivery/`](delivery) | `chant` | the chant project, off chud (INTENTIUS/chant#2737, ws-056): the release Op (Check, the ship-skip decision point, then the ship gate), the app component's supply chain, the Fly site, the agents that build the app, and this repo's CI. The dispatch Op, the local site and the write-scope policy are the kit's |",
    required: "the delivery row naming chud's runtime package and the release, rollback, upgrade and dispatch Ops",
    unless: /^(?![\s\S]*chud's runtime package)/,
  },
  {
    find: "npm run release      # chant run release --on chud: check, plan, stop at the ship gate\nchant approve release ship --plan <digest>\nnpm run release      # ship it\nnpm run rollback\nnpm run upgrade      # move to a newer @intentius/chud-runtime, through its gate\nnpm run check        # the app's tests and every approved contract's check (CI runs this)\nnpm run lint         # chant lint agents, with the contract-sizing rules",
    replace:
      "npm run release      # chant run release: check, ask ship-skip, stop at the ship gate\nchant approve release ship --plan <digest>\nnpm run release      # ship it\nnpm run upgrade      # cd .. && chant workspace upgrade\nnpm run check        # the app's own tests (CI runs this)\nnpm run lint         # chant lint agents",
    required: "the everyday commands naming --on chud, npm run rollback and the contract-sizing rules",
    unless: /^(?![\s\S]*--on chud: check, plan)/,
  },
];

const CLAUDE_EDITS: Edit[] = [
  {
    find: "| delivery | `delivery/` | The chant project: `chant.config.ts` (this repo's settings as `buildParams`: ports and how to run the app), `ops/` (the release, rollback, upgrade and dispatch Ops), `deploy/` (the app as a chant component and the sites it ships to), `agents/team.ts` (the agents that build the app, as fountain specs), `decisions/` (the decision points and the ship gate's Cedar policy), `ci/ci.ts` (this repo's CI), `.chant/` (the write-scope policy and the contract-sizing lint rules), and `node_modules/`. |",
    replace:
      "| delivery | `delivery/` | The chant project: `chant.config.ts` (this repo's settings as `buildParams`: ports and how to run the app), `ops/` (the release Op), `deploy/` (the app as a chant component and the Fly site's resources), `agents/team.ts` (the agents that build the app, as fountain specs; its factory Schedule still calls the kit's dispatch Op), `decisions/ship-skip.cedar.ts` (the ship gate's policy; the decision points are the workspace's `decisions/points.json` at the root), `ci/ci.ts` (this repo's CI), and `node_modules/`. |",
    required: "the delivery row naming the release, rollback, upgrade and dispatch Ops and .chant/",
    unless: /^(?![\s\S]*the release, rollback, upgrade and dispatch Ops)/,
  },
  {
    find: "- Records keep their core fields in YAML front matter (or JSON), validated\n  against the schemas in\n  `delivery/node_modules/@intentius/chud-runtime/schemas/`. Extra fields must\n  start with `x-`.\n",
    replace:
      "- Records keep their core fields in YAML front matter (or JSON), validated\n  against the schema each kind declares beside it (`decision.schema.json`,\n  `evidence.schema.json`, `session.schema.json`,\n  `design/schemas/defs.schema.json`). Extra fields must start with `x-`.\n",
    required: "the records bullet pointing at delivery/node_modules/@intentius/chud-runtime/schemas/",
    unless: /^(?![\s\S]*chud-runtime\/schemas\/)/,
  },
  {
    find: "- `delivery/node_modules/@intentius/chud-runtime` is the machinery (the design\n  app, the Op steps). It is a versioned dependency: never edit it. Upgrade it\n  with the upgrade Op (`npm run upgrade` in `delivery/`), which stops at a\n  gate for a person.\n",
    replace:
      "- The design app and its Op steps are the studio kit's now\n  (arugula-salad/studio, template/), not a `delivery/` dependency\n  (INTENTIUS/chant#2737, ws-056). Upgrade `delivery/`'s chant packages with\n  `npm run upgrade` (`chant workspace upgrade` at the root), which stops at a\n  gate for a person.\n",
    required: "the bullet naming delivery/node_modules/@intentius/chud-runtime as the machinery",
    unless: /^(?![\s\S]*is the machinery)/,
  },
];

const DESIGN_CLAUDE_EDITS: Edit[] = [
  {
    // The template's own name parameter ({{chant:name}}) is already
    // substituted by the time this migration runs, so the anchor captures
    // whatever it became rather than matching the placeholder literally.
    find: /You are inside the design app \(`chud design`\), and your working directory is\nthis one\. The team uses the app to write contracts, record decisions and ship\nreleases of ([^\n.]+)\. Your job is to change this app when the team\nasks: new views, different workflows, extra checks, whatever helps them build\n\1\. You do not build the app itself here; that happens in `chud\ndev` \(see `\.\.\/app\/CLAUDE\.md`\)\./,
    replace:
      "You are inside the design app. Its own CLI command is gone now that\n`@intentius/chud-runtime` is gone (INTENTIUS/chant#2737, ws-056); the design\napp is hud's chant views now (alecraso/hud#627). The team still uses it to\nwrite contracts, record decisions and ship releases of $1, and\nyour job stays the same: change this app when the team asks: new views,\ndifferent workflows, extra checks, whatever helps them build\n$1. You do not build the app itself here; that happens with\n`npm run dev` in `app/` (see `../app/CLAUDE.md`).",
    required: "the paragraph naming the design app's `chud design`/`chud dev` commands",
    unless: /^(?![\s\S]*chud design)/,
  },
  {
    find: "The design app ships in the `@intentius/chud-runtime` package, the version\n`../delivery/package-lock.json` pins, at\n`../delivery/node_modules/@intentius/chud-runtime/design/`. `chud design` runs\nits `server.js` directly. Read it there, but never edit it: an `npm install`\nor an upgrade replaces it. This directory holds only this repo's overrides,\nand they win:",
    replace:
      "The design app used to ship in the `@intentius/chud-runtime` package, at\n`../delivery/node_modules/@intentius/chud-runtime/design/`. That package is\ngone (INTENTIUS/chant#2737, ws-056): the design app is hud's chant views now\n(alecraso/hud#627), not a `delivery/` dependency. This directory still holds\nonly this repo's overrides, and they win once hud reads them from here:",
    required: "the paragraph naming @intentius/chud-runtime's design/ path",
    unless: /^(?![\s\S]*chud design)/,
  },
  {
    find: "- `design/lib/ops.js`: runs the chant Ops in `../delivery/ops/` (`chant run\n  <op> --on chud --json`, in `../delivery/`), reads the gate ledger on the\n  `chant/lifecycle` branch, and approves gates with `chant approve`.\n",
    replace:
      "- `design/lib/ops.js`: runs the chant Ops in `../delivery/ops/` (`chant run\n  <op> --json`, in `../delivery/`), reads the gate ledger on the\n  `chant/lifecycle` branch, and approves gates with `chant approve`.\n",
    required: "the ops.js bullet's --on chud flag",
    unless: /^(?![\s\S]*--on chud --json)/,
  },
];

// ── package.json ─────────────────────────────────────────────────────────────

const SCRIPT_MOVES: Record<string, { from: RegExp; to: string | null; why: string; notMoved?: NotMoved }> = {
  dev: { from: /^chud dev$/, to: null, why: "`chud dev` is hud on the box", notMoved: { what: "`npm run dev` (`chud dev`)", where: `hud, serving the app on the box: ${KIT}, alecraso/hud#627` } },
  design: { from: /^chud design$/, to: null, why: "`chud design` is hud's chant views", notMoved: { what: "`npm run design` (`chud design`)", where: "hud's chant views (jhgaylor/chud#79, alecraso/hud#627)" } },
  release: { from: /^chant run release --on chud$/, to: "chant run release", why: "chant's local executor runs the Op" },
  rollback: { from: /^chant run rollback --on chud$/, to: null, why: "the rollback Op is deleted" },
  upgrade: { from: /^chant run upgrade --on chud$/, to: "cd .. && chant workspace upgrade", why: "the lineage upgrade replaces the chud-runtime bump" },
  dispatch: { from: /^chant run dispatch --on chud$/, to: null, why: "the dispatch Op is the kit's" },
};

function rangeFloor(range: string): number[] | null {
  const m = /^(?:\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The delivery project's package.json without the chud packages, on this chant. */
function fixPackageJson(text: string, chantVersion: string, appRel: string): { text: string; notes: string[]; notMoved: NotMoved[] } {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const notes: string[] = [];
  const notMoved: NotMoved[] = [];
  const floor = rangeFloor(chantVersion);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const name of CHUD_PACKAGES) {
      if (name in deps) {
        delete deps[name];
        notes.push(`drops ${name}`);
      }
    }
    if (floor) {
      for (const [name, range] of Object.entries(deps)) {
        if (!/^@intentius\/chant(?:-lexicon-[a-z0-9-]+)?$/.test(name)) continue;
        const at = rangeFloor(range);
        if (at && older(at, floor)) deps[name] = `^${chantVersion}`;
      }
    }
    pkg[field] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  }
  const deps = (pkg.dependencies ??= {}) as Record<string, string>;
  if (!("@intentius/chant-lexicon-systemone" in deps)) {
    deps["@intentius/chant-lexicon-systemone"] = floor ? `^${chantVersion}` : (deps["@intentius/chant"] ?? "*");
    pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
    notes.push("adds @intentius/chant-lexicon-systemone for the decide step");
  }
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts) {
    for (const [name, move] of Object.entries(SCRIPT_MOVES)) {
      if (typeof scripts[name] !== "string" || !move.from.test(scripts[name])) continue;
      if (move.to === null) delete scripts[name];
      else scripts[name] = move.to;
      if (move.notMoved) notMoved.push(move.notMoved);
    }
    if (scripts.check === "node ops/site.mjs ci") scripts.check = `npm --prefix ${appRel} test --silent`;
    // The release Op's Build phase writes the Fly app's requests with it.
    if (scripts.release === "chant run release" && !("build:fly" in scripts)) scripts["build:fly"] = "chant build deploy --lexicon fly -o dist/fly.json";
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/--on chud\b/.test(cmd)) scripts[name] = cmd.replace(/\s*--on chud\b/g, "");
      else if (/(^|[;&|]\s*)chud\s/.test(cmd)) notMoved.push({ what: `\`npm run ${name}\` (${cmd})`, where: `${KIT}: the chud CLI is not installed once the runtime is gone` });
    }
  }
  return { text: JSON.stringify(pkg, null, 2) + "\n", notes, notMoved };
}

// ── Points ───────────────────────────────────────────────────────────────────

const KNOWN_OUTPUT = new RegExp(`^(?:${POINT_INPUT_OUTPUT_NAMES.map((n) => n.replace(/[-]/g, "\\-")).join("|")})(?:\\.|$)`);

/**
 * chud's `slice-tier` point tells its decider where the sizing limits are:
 * "(lint.rules in chant.config.ts)". This migration removes that `lint`
 * block (`configEdits`), so the converted point would point at nothing
 * (#2805). Its sizing rules are the kit's now, per the plan's own `DELETED`
 * entry for `.chant/rules/contract-sizing.ts`.
 */
function fixSizingReference(instructions: string): string {
  return instructions.replace("(lint.rules in chant.config.ts)", "(the studio kit's contract-sizing rules, arugula-salad/studio, template/)");
}

/** chud's points.yaml as chant's points file, or the reason it cannot be. */
export function convertPoints(text: string, file: string): { json: string } | { error: string } {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return { error: `is not YAML: ${(err as Error).message}` };
  }
  const src = (doc as { points?: Record<string, Record<string, unknown>> } | null)?.points;
  if (!src || typeof src !== "object") return { error: "declares no `points`" };
  const points: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [name, point] of Object.entries(src)) {
    const map = POINT_OUTPUTS[name];
    const rename = (input: string): string | null => {
      if (KNOWN_OUTPUT.test(input)) return input;
      if (!map) return null;
      return `${map.output}.${map.rename?.[input] ?? input}`;
    };
    const inputs: Record<string, string> = {};
    let ok = true;
    for (const [k, v] of Object.entries((point.inputs as Record<string, string> | undefined) ?? {})) {
      const n = rename(k);
      if (n === null) ok = false;
      else inputs[n] = v;
    }
    if (!ok) {
      unknown.push(name);
      continue;
    }
    const question = { ...(point.question as Record<string, unknown>) };
    if (question.type === "boolean") question.type = "noul";
    if (typeof question.instructions === "string") question.instructions = fixSizingReference(question.instructions);
    const deciders = ((point.deciders as Array<Record<string, unknown>> | undefined) ?? []).map((d) => {
      if (d.kind !== "table") return d;
      const rows = (d.rows as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        when: Object.fromEntries(Object.entries((r.when as Record<string, unknown>) ?? {}).map(([k, v]) => [rename(k) ?? k, v])),
      }));
      return { ...d, rows };
    });
    points[name] = { ...point, question, inputs, deciders };
  }
  if (unknown.length > 0) {
    return {
      error: `point(s) ${unknown.join(", ")} name inputs with no read-contract output, and only chud's slice-tier and ship-skip have a known one. Write them into decisions/points.json by hand, each input prefixed by its output (work-item., release., finding., ...), then run the upgrade again`,
    };
  }
  const json = JSON.stringify({ $schema: DECISION_POINTS_SCHEMA_ID, points }, null, 2) + "\n";
  try {
    parsePoints(json, file);
  } catch (err) {
    if (err instanceof PointsError) return { error: `does not validate once converted: ${err.message}` };
    throw err;
  }
  return { json };
}

// ── The plan ─────────────────────────────────────────────────────────────────

interface Declaration {
  members?: Array<{ name?: string; dir?: string; kind?: string }>;
  records?: Array<{ kind?: string }>;
}

function readDeclaration(dir: string): Declaration | null {
  const text = readText(dir, "chant.workspace.json");
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as Declaration;
  } catch {
    return null;
  }
}

function dependsOnChud(dir: string, member: string): boolean {
  const text = readText(dir, posix.join(member, "package.json"));
  if (text === undefined) return false;
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((f) => CHUD_PACKAGES.some((p) => pkg[f]?.[p] !== undefined));
  } catch {
    return false;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".chud", ".data", ".hud"]);

/** Every file in the scope that chud's packages could be imported from. */
function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    if (SKIP_DIRS.has(name) || (rel === "" && name === ".chant")) continue;
    const path = rel ? `${rel}/${name}` : name;
    const st = statSync(join(dir, path));
    if (st.isDirectory()) out.push(...sourceFiles(dir, path));
    else if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(name) && st.size < 2_000_000) out.push(path);
  }
  return out;
}

function planExit(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir, lineage, chantVersion } = ctx;
  const decl = readDeclaration(dir);
  const members = decl?.members ?? [];
  const delivery = members.filter((m) => m.kind === "chant" && m.dir && dependsOnChud(dir, m.dir)).map((m) => posix.normalize(m.dir!));
  if (delivery.length === 0 && dependsOnChud(dir, "delivery")) delivery.push("delivery");

  const changes: PlannedChange[] = [];
  const notMoved: NotMoved[] = [];
  const conflicts: PlanConflict[] = [];
  const edited = (path: string, text: string): boolean => {
    const entry = lineage.files[path];
    return entry !== undefined && entry.sha256 !== fileHash(text);
  };
  const write = (path: string, text: string, why: string): void => {
    const current = readText(dir, path);
    if (current === text) return;
    changes.push({ path, action: "write", why, data: Buffer.from(text), ...(current !== undefined && edited(path, current) ? { edited: true } : {}) });
  };
  const remove = (path: string, why: string): void => {
    const current = readText(dir, path);
    if (current === undefined) return;
    changes.push({ path, action: "delete", why, ...(edited(path, current) ? { edited: true } : {}) });
  };
  const edit = (path: string, edits: Edit[], why: string, after?: (t: string) => string): void => {
    const current = readText(dir, path);
    if (current === undefined) return;
    const { text, missing } = applyEdits(current, edits);
    if (missing.length > 0) {
      conflicts.push({ path, reason: `cannot find ${missing.join("; ")}. Take it off the chud packages by hand, then run the upgrade again` });
      return;
    }
    write(path, after ? after(text) : text, why);
  };

  const appDir = members.find((m) => m.name === "app")?.dir ?? "app";
  const designDir = members.find((m) => m.name === "design")?.dir ?? "design";

  for (const d of delivery) {
    const at = (p: string) => posix.join(d, p);
    const appRel = posix.relative(d, appDir) || ".";

    // The chud lexicon's shim and its runtime.
    const shim = at("ops/chant-lexicon-chud");
    if (existsSync(join(dir, shim))) {
      for (const f of sourceFilesUnder(dir, shim)) remove(f, "the chud lexicon's entry, re-exporting @intentius/chud-runtime");
    }
    const npmrc = readText(dir, at(".npmrc"));
    if (npmrc !== undefined && npmrc.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n") === "install-links=true") {
      remove(at(".npmrc"), "it only installed the chud lexicon's file: dependency");
    }

    // package.json.
    const pkgPath = at("package.json");
    const pkgText = readText(dir, pkgPath)!;
    const pkg = fixPackageJson(pkgText, chantVersion, appRel);
    write(pkgPath, pkg.text, `${pkg.notes.join(", ") || "updates the chant ranges"}; scripts run chant alone`);
    notMoved.push(...pkg.notMoved);

    // Files that were chud's only.
    for (const del of DELETED) {
      if (readText(dir, at(del.path)) === undefined) continue;
      remove(at(del.path), del.why);
      if (del.notMoved) notMoved.push(del.notMoved);
    }

    // The decision points.
    const yamlPath = at("decisions/points.yaml");
    const yamlText = readText(dir, yamlPath);
    if (yamlText !== undefined) {
      const converted = convertPoints(yamlText, "decisions/points.json");
      if ("error" in converted) {
        conflicts.push({ path: yamlPath, reason: converted.error });
      } else {
        const existing = readText(dir, "decisions/points.json");
        if (existing !== undefined && existing !== converted.json) {
          conflicts.push({ path: "decisions/points.json", reason: `exists, and ${yamlPath} would replace it. Merge the two by hand, delete ${yamlPath}, then run the upgrade again` });
        } else {
          write("decisions/points.json", converted.json, `chud's ${yamlPath}, as chant's points file (inputs named for their read-contract outputs)`);
          remove(yamlPath, "moved to decisions/points.json");
        }
      }
    }
    const pointsRel = posix.relative(at("ops"), "decisions/points.json");

    // The answer kind, declared.
    if (!existsSync(join(dir, "answers/answer.kind.mjs"))) {
      write("answers/answer.kind.mjs", ANSWER_KIND, "the answer kind for the decision points (ws-058)");
      write("answers/answer.schema.json", JSON.stringify(answerSchema, null, 2) + "\n", "a copy of chant's point-answer schema");
    }
    const declText = readText(dir, "chant.workspace.json");
    if (declText !== undefined && decl) {
      const records = decl.records ?? [];
      if (!records.some((r) => r.kind === "answers/answer.kind.mjs")) {
        const next = { ...decl, records: [...records, { kind: "answers/answer.kind.mjs" }] } as Record<string, unknown>;
        write("chant.workspace.json", JSON.stringify(next, null, 2) + "\n", "declares the answer kind");
      }
    }

    // The release Op and the app component.
    if (readText(dir, at("ops/release.op.ts")) !== undefined) {
      write(at("ops/release.op.ts"), releaseOp(pointsRel, appRel), "chant's release Op: Check, Build, Plan with the ship-skip point through decide, the ship gate on the plan's digest, Ship to Fly, and Record");
      notMoved.push({ what: "signing the release archive, and checking the signature before the Machine runs it (chud's release-sign and release-verify)", where: `${SIGN_ISSUE}: blob signing for a source archive` });
    }
    if (readText(dir, at("deploy/app.component.ts")) !== undefined) {
      write(at("deploy/app.component.ts"), appComponent(appRel), "the app component on chant's supply-chain verbs (SBOM, scan, vuln-gate)");
    }

    // Files the project keeps, edited.
    edit(at("chant.config.ts"), configEdits(), "lexicons without chud and with systemone; no chud lint rules", fixConfig);
    edit(at("deploy/fly.ts"), FLY_EDITS, "the Fly app on the fly lexicon alone, without chud's FlySite");
    edit(at("deploy/fly-machine.ts"), FLY_MACHINE_EDITS, "a comment that named chud-runtime's fly-site.mjs");
    edit(at("decisions/ship-skip.cedar.ts"), CEDAR_EDITS, "the policy reads the decide step's answer and decider");
    edit(at("ci/ci.ts"), CI_TS_EDITS, "CI no longer fetches the private chud runtime");

    const team = readText(dir, at("agents/team.ts"));
    if (team?.includes('"chant run dispatch"')) {
      notMoved.push({ what: `the factory's Schedule in ${at("agents/team.ts")} runs \`chant run dispatch\``, where: `${KIT}: its dispatch Op (arugula-salad/studio#47); the Schedule fails until that Op is here` });
    }
    const config = readText(dir, at("chant.config.ts"));
    if (config && /\bvulnDb\b/.test(config)) {
      notMoved.push({ what: "buildParams.vulnDb (CHUD_VULN_DB), the pinned advisory database", where: "INTENTIUS/chant#2515: chant's scan reads it once the config fallback lands; until then grype or trivy" });
    }
  }
  edit(".github/workflows/ci.yml", CI_YML_EDITS, "built from ci/ci.ts again (`npm run ci:build`)");

  // The repo's prose (#2805): README.md, CLAUDE.md and design/CLAUDE.md
  // describe chud's runtime, `--on chud` and the Ops and paths this migration
  // deletes. Rewrite the passages this migration knows about; an edit whose
  // anchor is gone (a different template shape) is a conflict, same as the
  // code files above.
  edit("README.md", README_EDITS, "the delivery row and everyday commands, off chud");
  edit("CLAUDE.md", CLAUDE_EDITS, "the delivery row, the schema path and the upgrade Op, off chud");
  edit(posix.join(designDir, "CLAUDE.md"), DESIGN_CLAUDE_EDITS, "the design app is the kit's now; no --on chud");

  // Whatever still imports the chud packages once the plan ran is a conflict.
  const planned = new Map(changes.map((c) => [c.path, c]));
  for (const f of sourceFiles(dir)) {
    const c = planned.get(f);
    if (c?.action === "delete") continue;
    const text = c?.data ? c.data.toString("utf-8") : readText(dir, f)!;
    if (CHUD_IMPORT.test(text)) {
      conflicts.push({ path: f, reason: "imports the chud packages, and this migration does not know the file. Move it off them by hand (see ws-056 for where each part went), then run the upgrade again" });
    }
  }

  if (delivery.length === 0 && conflicts.length === 0) return null;
  if (delivery.length > 0) notMoved.push({ what: "decision-point answers already on chud's `chud/decisions` branch", where: "they stay chud's; new answers are chant records in answers/" });
  return {
    id: CHUD_LEXICON_EXIT,
    description: "take the repo off @intentius/chant-lexicon-chud and @intentius/chud-runtime (ws-056)",
    changes,
    notMoved: dedupe(notMoved),
    conflicts,
  };
}

function sourceFilesUnder(dir: string, rel: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    const path = `${rel}/${name}`;
    if (statSync(join(dir, path)).isDirectory()) out.push(...sourceFilesUnder(dir, path));
    else out.push(path);
  }
  return out;
}

function dedupe(items: NotMoved[]): NotMoved[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.what) ? false : (seen.add(i.what), true)));
}

export const chudLexiconExit: ChantMigration = {
  id: CHUD_LEXICON_EXIT,
  description: "take the repo off @intentius/chant-lexicon-chud and @intentius/chud-runtime (ws-056)",
  plan: planExit,
};
