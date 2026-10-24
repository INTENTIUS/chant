/**
 * chant #4215: the fold differential's classification lists, in a module of
 * their own so the unit project can check them against the corpus on every
 * pull request (`examples/static-gates.test.ts`). The e2e differential
 * (`fold-differential.e2e.test.ts`) imports the same lists and checks them
 * against what actually folds.
 */

/**
 * chant #1039 — fold COVERAGE regression gate.
 *
 * The byte-identical assertion below only fires for entries that already
 * fold (mode "fold") — an entry that quietly stops folding and falls back to
 * run instead reports `identical: true` (run-vs-run has no drift by
 * definition) and the whole suite stays green. That is a real, silent
 * coverage regression the differential's original design (#1025) had no gate
 * for at all.
 *
 * This is the committed baseline: every corpus entry that folds today (as of
 * this branch — see the PR that introduced this list for the exact
 * before/after against `main`). A name-by-name check, not just a count,
 * because a count alone can't tell "A regressed, B started folding" apart
 * from "nothing changed" — exactly the failure mode a bare total would hide.
 * Update this list only when you've confirmed (via `just fold-differential
 * --reporter=verbose`, comparing the full per-entry classification against
 * `main`, not just the summary line) that a removal is an intentional,
 * understood behavior change — never to silence a red run.
 *
 * chant #1020 (epic #1019) grew this from 15 to 21 by resolving identifiers
 * across the module graph — an imported `const`, or an imported resource
 * referenced via `.attr`, now folds instead of failing the whole importing
 * file on the first identifier it doesn't recognize. The 6 entries added
 * here (`alert-triage`, `bedrock-agentcore-agent`, `getting-started`,
 * a since-deleted runtime example, `lifecycle-reconcile-aws`,
 * `layered-config`) were exactly the corpus entries where cross-file
 * resolution was the ONLY
 * remaining blocker; most of the run-fallback corpus needs #1044
 * (call-as-a-value) too, or an unrelated shape gap (a resource constructor
 * whose first argument isn't the props object literal, a nested `new` used
 * as a value — pre-existing #1022-era limitations, not cross-file), so this
 * PR doesn't move those, by design.
 *
 * chant #1082 grew it from 21 to 24. The three added entries (`fargate-alb`,
 * `multi-service-alb`, `vpc`) are the corpus's `new Parameter("String",
 * {...})` users: the AWS deploy-time `Parameter` takes `(type, props)`, and
 * `foldResource` used to require argument 0 to be the props object literal,
 * so no `new Parameter(...)` could fold anywhere. Constructor arguments now
 * fold positionally. The same PR made chant's own registered authoring
 * helpers (`phase`, `output`, …) foldable, which doesn't move any corpus
 * entry on its own — the corpus has no component-authoring entry gated
 * solely on one — but is what unblocks real component-using applications.
 *
 * chant #1044 grew it from 24 to 32. The eight added entries are the AWS
 * examples whose only blocker was `Ref(...)` used as a value — seven
 * `lambda-*` plus `rds-postgres` — now that a registered intrinsic's
 * plain-call form folds when its lexicon opts it in. Two more AWS entries
 * (`shared-alb-api`, `shared-alb-ui`) cleared their `Ref` blocker and stopped
 * on the next one (a nested `new Parameter(...)` as a composite argument),
 * and both azure entries whose only blocker was `Concat(...)` cleared it and
 * stopped on `Azure.ResourceGroupLocation` — a lexicon-package namespace
 * access, #1063. That is the measured ceiling this PR reports: azure's
 * remaining corpus is gated on #1063, not on #1044.
 *
 * chant #1112 grew it from 53 to 54 by ADDING an entry, not by folding an
 * existing one: `lexicons/aws/examples/stack-outputs` declares all three
 * output shapes (`output(ref, …)`, `output(intrinsic, …)`, `stackOutput(ref)`)
 * in a file separate from the resources they reference, which is what fold
 * was silently dropping. Thirteen corpus entries already had an `output(...)`
 * in a folding file and still reported `[identical]` — see this suite's
 * `buildBothWays`/`loadBuild` for why, and the #1112 PR for the before/after.
 *
 * chant #1169 grew it from 55 to 76 — the largest single jump so far, by
 * lifting the rejection of a `new Type(...)` used as a VALUE. That one cause
 * was the corpus's biggest gate (64 files, the sole blocker in 22 entries), and
 * it covered two authoring shapes the old reason string conflated: the
 * construction written inline (`image: new Image({...})`), which now folds to a
 * `{__resource}` envelope the bridge constructs for real, and the far more
 * common one that names it first (`const nodeImage = new Image({...})` then
 * `image: nodeImage`), which needed the same-file resource pre-pass in
 * `fold-import.ts`. The 21 added entries are every corpus entry whose remaining
 * blockers were that cause plus the taint it induced: the five k8s
 * `new Container(...)`/`new Probe(...)` examples, four gitlab pipelines, the
 * four fly deploys, `fly/getting-started`, and the seven aws/gitlab shared-ALB
 * entries whose `params.ts`/`network.ts` were only falling back because a
 * sibling did. Two entries in that class did NOT flip and are honest about
 * why: `gitlab/monorepo-pipeline` (`workspaces.map(...)`) and
 * `github/release-please` (`Checkout(...)`) each stop on a function call as a
 * value, one blocker behind the one this change removed.
 *
 * chant #1063 grew it from 32 to 53 — the largest jump before that, and
 * the whole of azure's and gcp's corpora at once. The 21 added entries are
 * every azure example (13) and every gcp example (8): each had exactly one
 * file, failing on `Azure.<PseudoParameter>` / `GCP.<PseudoParameter>` — an
 * identifier imported from the LEXICON PACKAGE rather than from a sibling
 * project file, which #1020's cross-file resolution skipped by construction
 * (it followed relative specifiers only). Following a bare specifier into an
 * ACTIVE lexicon package also cleared every remaining `S3Actions` (aws),
 * `CI` (gitlab) and value-position `AWS` (aws) failure in the corpus, but
 * those all live in `docs-snippets` entries carrying several unrelated
 * blockers apiece, so they move no entry on their own.
 *
 * chant #1174 grew the corpus's folding count from 82 to 89 (the corpus
 * itself had also grown, 101 -> 108, from unrelated additions between #1169
 * and this PR — this list only tracks what #1174 itself moved). Two
 * independent mechanisms shared one cause string, "function call as a value
 * is not foldable", and both needed closing:
 *
 *   - **A composite factory call narrowed to `.step`** — `Checkout({...}).step`,
 *     `SetupNode({...}).step` — every lexicon's single-action `Composite()`
 *     wrapper, embedded inline in a `Job`'s `steps` array exactly as
 *     composites.mdx documents. `fold()` gained a narrow, EVL-parity-matched
 *     case for exactly this shape (chant #1544's `allowCompositeStepAccess`
 *     already carved the identical shape out of EVL001 as a documented,
 *     correct fallback — this is the fold-side counterpart that actually
 *     reduces it). The four added entries: `lexicons/github/examples/getting-started`,
 *     `deploy-pages`, `release-please`, and `lexicons/forgejo/examples/ci-workflow`.
 *     Four more github entries (`docker-build`, `matrix-test`, `node-ci`,
 *     `reusable-workflow`) have a Checkout call too but do NOT flip — each
 *     stops on a DIFFERENT, unrelated blocker one step behind it: a `.toString()`
 *     method call on `github.actor`/`matrix(...)`/`inputs(...)` (an
 *     Expression-returning helper, not a registered intrinsic), or an array
 *     `.join(...)` inside a step's `run:` string. Method-call folding is a
 *     separate, unscoped gap this PR does not attempt.
 *   - **Helm's call-form intrinsics opted into `foldsAsCall`** — `include`,
 *     `printf`, and `toYaml` (plus `required`/`helmDefault`/`quote`/`tpl`/
 *     `lookup`/`filesGet`/`filesGlob`/`filesAsConfig`/`filesAsSecrets`,
 *     audited the same way but not exercised by the corpus) were registered
 *     with `isTag: false` and no `foldsAsCall` — helm has no tagged
 *     templates at all, so before this PR literally zero helm intrinsic
 *     calls ever folded. The three added entries — `lexicons/helm/examples/cron-job`,
 *     `multi-container`, `stateful-service` — each used `include`/`printf`/
 *     `toYaml` together, so all three needed opting in before any of them
 *     could flip.
 *
 * chant #1966 grew the count from 89 to 95 (the corpus itself also grew, 108
 * -> 108 net — additions and the docker-build/matrix-test/node-ci/reusable-
 * workflow four were already counted at #1174) by closing the method-call gap
 * #1174 left open: `fold()` had no case for a `CallExpression` whose callee is
 * a property access, so `github.actor.toString()`/`matrix("os").toString()`/
 * `[...].join(...)` all fell through to "function call as a value is not
 * foldable". Two additions: (1) a lexicon-package plain function (github's
 * `matrix`/`inputs`/`needs`/… expression helpers) opted into EAGER folding
 * (`IntrinsicDef.foldsEagerly`, ../packages/core/src/lexicon.ts) evaluates
 * immediately rather than enveloping for later revival, which is what lets
 * its result stringify correctly when embedded straight into a template
 * literal; (2) a method call whose receiver already resolves to a real value
 * (a live external, an array/object literal, or one of the above) invokes the
 * named method directly. Six entries flip: the four github ones #1174 left
 * one blocker behind, plus `examples/k8s-aks-microservice` and
 * `k8s-gke-microservice`, whose ingress config chains
 * `config.domain.split(".").slice(-2).join(".")`.
 *
 * The cpln lexicon (#1533) added three entries and two of them: its
 * `secret-access` example stays out because it reads the secret's value from
 * `process.env` at build time, which is the pattern that lexicon's own docs
 * recommend and which the folder refuses on purpose.
 *
 * chant #2171 adds one, `examples/fountain-steward`, which had never folded
 * since it joined the corpus at #2129. Its three `*.op.ts` files
 * default-exported their Op because Op discovery read `mod.default` and
 * nothing else, and `export default` is the one export shape the fold path
 * refuses, so all four files fell back, `fountain.ts` included since it
 * imports all three. Two changes, both in this PR: `discoverOps` accepts a
 * named export (the default export still works, so no other `*.op.ts` file in
 * the repo moved), and the ConvergeOp rule builders `when`/`gt`/`report` and
 * their siblings joined `FOLDABLE_AUTHORING_HELPERS`, without which
 * `prod-converge.op.ts` still fell back on `when(...)` once the default export
 * was gone. Nothing else in the corpus is affected: `export default` was the
 * sole fallback reason for exactly these four files, and the only other files
 * it disqualifies corpus-wide are three `chant.config.ts` fixtures whose
 * entries fall back for unrelated reasons anyway.
 *
 * chant #2251 adds `examples/k8s-eks-microservice`, the one member of the k8s
 * trio that had never folded. Nothing in the fold path changed for it; the
 * example moved. Its IRSA trust policy was built by a local function that
 * called `JSON.stringify`, and its stack outputs and the OIDC issuer
 * `Select(1, Split(...))` read attributes off resources declared in the same
 * file, which a folded intrinsic or authoring helper cannot resolve. The trust
 * policy is now literal strings, the IRSA roles moved to `infra/irsa.ts` and
 * every output to `infra/outputs.ts`, so each of those reads is a cross-file
 * import the resolver answers with the real instance — the shape
 * `lexicons/aws/examples/stack-outputs` already teaches. The rendered
 * CloudFormation template and Kubernetes manifests are byte-identical to what
 * the run path produced before the move.
 */
/**
 * chant #2345 — mixed ("run-fallback") corpus entries whose fold-vs-run
 * comparison is KNOWN to diverge, with the reason. Populated from the first
 * run that compared mixed entries at all; each is a finding, not an excuse.
 * An entry here that stops diverging fails the run, so the list only shrinks.
 */
export const EXPECTED_MIXED_DIVERGENT: ReadonlyMap<string, string> = new Map<string, string>([
  // Empty as of the first full run over all 107 entries (95 fold, 12
  // run-fallback): drift 0. Every mixed entry agrees fold-vs-run. Add an
  // entry only with a reason and an issue; the gate fails when it stops
  // diverging.
]);

/**
 * Every corpus entry that does NOT fold today, and why — chant#2225.
 *
 * {@link EXPECTED_FOLD} is a ratchet over names known to fold, and the gate
 * below only walks names already in it. So an entry absent from that list can
 * never appear in `regressed`, whether it folds or not: a new corpus entry that
 * never folds passed by construction, and twice did.
 *
 * `lexicons/forgejo/examples/ci-workflow` joined in #1119 and stayed
 * run-fallback for a month until #1965. `examples/fountain-steward` joined in
 * #2129 with every `*.op.ts` default-exporting its Op, the one shape the fold
 * path refuses, and all four files fell back; the published count moved from
 * 96 of 110 to 96 of 111, denominator only, until #2189. Neither was caught
 * here, because neither dropped the numerator.
 *
 * This closes the corpus: an entry must be in one list or the other, and one in
 * neither fails by name. The reason is required at review time, which is the
 * same posture as `KNOWN_FAILURES` in `scripts/check-lexicons.ts` — a failure
 * not listed there is a regression.
 *
 * A reason here is a statement about chant, not an excuse. When one stops being
 * true the entry moves to {@link EXPECTED_FOLD}, and the gate below says so.
 */
export const EXPECTED_RUN_FALLBACK: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "examples/agent-observability",
    "`gatewayExporter(...)`, `ruleFileYaml(...)`, `GrafanaConfigMaps(...)` and `grafanaVolumes(...)` as values: the workloads carry configs rendered from other declarations at run time; the taint fixpoint then takes the files they import",
  ],
  [
    "examples/cc-aws-canonical",
    "a same-file resource reference passed to a folded intrinsic or authoring helper, and `kubectlApply(...)` as a value",
  ],
  ["examples/cc-azure-canonical", "`kubectlApply(...)` as a value"],
  [
    "examples/flux-apps",
    "`String(...)` as a value; the taint fixpoint then takes the files that import it",
  ],
  [
    "examples/fold-adversarial",
    "deliberate, and the one entry here that should never move: it exists to exercise refusals — the call-depth bound, a property read on undefined, a spread of a non-object",
  ],
  [
    "examples/gitlab-cells-single-region-gke",
    "`_cells.map(...)` as a value, and an `IfStatement` in a called function body",
  ],
  [
    "examples/ray-kuberay-gke",
    "a destructured composite call; the taint fixpoint then takes its importers and capturers",
  ],
  [
    "lexicons/aws/examples/core-concepts",
    "a function used as a value, and an exported destructured or uninitialized declaration",
  ],
  [
    "lexicons/aws/examples/docs-snippets",
    "`export default`, and composite calls (`VpcDefault(...)`, `SmartApi(...)`) as values",
  ],
  [
    "lexicons/aws/examples/lambda-api",
    "`export default`; the capture edge then takes the files that read its exports",
  ],
  [
    "lexicons/k8s/examples/otel-node-agent",
    "`Object.values(agent.members)` as a value: it reads the NodeAgent composite's members at run time",
  ],
  [
    "lexicons/cpln/examples/secret-access",
    "an ambient `process` read, which wants a build-time parameter instead",
  ],
  [
    "lexicons/docker/examples/dockerfile-sharing",
    "`NodeImage`, a `Composite` that takes props, is a function used as a value; the files that import `shared/node.ts` alongside it then run with it. Parameterized sharing is what the Dockerfiles page teaches, so this entry stays until #1023 folds composites",
  ],
  [
    "lexicons/github/examples/docs-snippets",
    "`Checkout(...)` as a value, and one file with no foldable resource exports",
  ],
  [
    "lexicons/gitlab/examples/docs-snippets",
    "`reference(...)` as a value; the taint fixpoint then takes its importers",
  ],
  ["lexicons/gitlab/examples/monorepo-pipeline", "a function used as a value"],
]);

export const EXPECTED_FOLD: readonly string[] = [
  "examples/adopt-alb-services",
  "examples/alert-triage",
  "examples/argo-cd-gke",
  "examples/bedrock-agentcore-agent",
  "examples/cc-gcp-canonical",
  "examples/cockroachdb-multi-region-gke",
  "examples/components-aws-e2e",
  "examples/demo-composed-stacks",
  "examples/fan-out-estate",
  "examples/fly-deploy-rollback",
  "examples/fly-durable-deploy",
  "examples/fly-reconcile",
  "examples/fountain-steward",
  "examples/getting-started",
  "examples/github-pr-preview",
  "examples/gitlab-aws-alb-infra",
  "examples/gitlab-aws-alb-services",
  "examples/k8s-aks-microservice",
  "examples/k8s-drift-to-source",
  "examples/k8s-eks-microservice",
  "examples/k8s-gke-microservice",
  "examples/local-cloud-trio",
  "examples/local-fly",
  "examples/testing-harness-aws",
  "examples/trunk-curated-floci",
  "lexicons/aws/examples/fargate-alb",
  "lexicons/aws/examples/lambda-dynamodb",
  "lexicons/aws/examples/lambda-eventbridge",
  "lexicons/aws/examples/lambda-function",
  "lexicons/aws/examples/lambda-s3",
  "lexicons/aws/examples/lambda-scheduled",
  "lexicons/aws/examples/lambda-sns",
  "lexicons/aws/examples/lambda-sqs",
  "lexicons/aws/examples/lifecycle-reconcile-aws",
  "lexicons/aws/examples/multi-service-alb",
  "lexicons/aws/examples/rds-postgres",
  "lexicons/aws/examples/shared-alb",
  "lexicons/aws/examples/shared-alb-api",
  "lexicons/aws/examples/shared-alb-ui",
  "lexicons/aws/examples/stack-outputs",
  "lexicons/aws/examples/vpc",
  "lexicons/azure/examples/aks-cluster",
  "lexicons/azure/examples/basic-storage",
  "lexicons/azure/examples/container-instance",
  "lexicons/azure/examples/cosmos-db",
  "lexicons/azure/examples/function-app",
  "lexicons/azure/examples/key-vault",
  "lexicons/azure/examples/multi-resource",
  "lexicons/azure/examples/private-endpoint",
  "lexicons/azure/examples/redis-cache",
  "lexicons/azure/examples/service-bus",
  "lexicons/azure/examples/sql-database",
  "lexicons/azure/examples/vnet-vms",
  "lexicons/azure/examples/web-app",
  "lexicons/cpln/examples/basic-service",
  "lexicons/cpln/examples/stateful-postgres",
  "lexicons/docker/examples/basic-app",
  "lexicons/docker/examples/otel-collector",
  "lexicons/fly/examples/getting-started",
  "lexicons/fly/examples/otel-collector",
  "lexicons/forgejo/examples/ci-workflow",
  "lexicons/gcp/examples/basic-bucket",
  "lexicons/gcp/examples/cloud-function",
  "lexicons/gcp/examples/cloud-run",
  "lexicons/gcp/examples/cloud-sql",
  "lexicons/gcp/examples/cloud-storage-lifecycle",
  "lexicons/gcp/examples/gke-cluster",
  "lexicons/gcp/examples/pubsub",
  "lexicons/gcp/examples/vpc-network",
  "lexicons/github/examples/deploy-pages",
  "lexicons/github/examples/docker-build",
  "lexicons/github/examples/getting-started",
  "lexicons/github/examples/matrix-test",
  "lexicons/github/examples/node-ci",
  "lexicons/github/examples/release-please",
  "lexicons/github/examples/reusable-workflow",
  "lexicons/gitlab/examples/docker-build",
  "lexicons/gitlab/examples/getting-started",
  "lexicons/gitlab/examples/multi-stage-deploy",
  "lexicons/gitlab/examples/node-pipeline",
  "lexicons/gitlab/examples/python-pipeline",
  "lexicons/gitlab/examples/review-app",
  "lexicons/helm/examples/composites-basic",
  "lexicons/helm/examples/composites-infrastructure",
  "lexicons/helm/examples/composites-production",
  "lexicons/helm/examples/cron-job",
  "lexicons/helm/examples/microservice-chart",
  "lexicons/helm/examples/multi-container",
  "lexicons/helm/examples/stateful-service",
  "lexicons/helm/examples/web-app-with-ingress",
  "lexicons/k8s/examples/basic-deployment",
  "lexicons/k8s/examples/batch-workers",
  "lexicons/k8s/examples/configmap-secret",
  "lexicons/k8s/examples/cronjob-cleanup",
  "lexicons/k8s/examples/ingress-tls",
  "lexicons/k8s/examples/layered-config",
  "lexicons/k8s/examples/namespace-rbac",
  "lexicons/k8s/examples/operator-stack",
  "lexicons/k8s/examples/org-policy",
  "lexicons/k8s/examples/otel-collector",
  "lexicons/k8s/examples/otel-gateway",
  "lexicons/k8s/examples/statefulset",
  "lexicons/k8s/examples/web-platform",
];
