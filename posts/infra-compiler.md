# A TypeScript compiler for Kubernetes manifests, not another config language

A GitOps pipeline on Kubernetes is full of tools. Reconcilers like Flux or Argo watch git and converge the cluster. Drift gets detected and alarmed while policy engines gate what reaches the cluster at every stage.

The least guarded stage is the one where the manifests get written. YAML gets patched with Kustomize and templated with Helm, then goes unchecked for meaning until the reconciler tries to apply it.

**chant** is a compiler for that layer. Typed TypeScript goes in and native Kubernetes YAML comes out. The build type checks and semantic lints and synthesizes deterministically, then stops and hands a standard manifest to the existing deploy path.

![A TypeScript compiler for Kubernetes manifests](infra-compiler-diagrams/01-infra-compiler.png)

## Rendering != coherence

Kustomize and Helm may render a Service whose selector matches no pods, a probe pointing at a port nothing serves, a reference to a resource that does not exist. The YAML is well-formed, but the failure surfaces at apply time or later when the alarm fires.

A real infra compiler inverts this. chant imports the `.ts` files, reads the exported resource objects, validates each against a lexicon's semantic rules, and emits the target format. chant is a **synthesis compiler** and the emphasis falls on synthesis. The build never calls the cluster API, never holds state, and never deploys. TypeScript declares intent and the build produces an artifact and stops.

Synthesis stays side-effect-free, so the authoring layer becomes legible. The same source always produces the same output and every value traces back to a line.

## No new language to learn

Typed configuration is not new. Dhall, CUE, KCL, and Pkl bring types and validation to YAML. cdk8s, CDK, and Pulumi synthesize manifests from code. chant's unique approach is a combination of three properties the others tend to split between them.

- **A mainstream language, not a new DSL.** CUE, Dhall, KCL, and Pkl are languages a team adopts and tools from scratch. chant is TypeScript with the editor and autocomplete and go-to-definition and review workflow already in place.
- **Synthesis, not execution.** cdk8s, CDK, and Pulumi run code to produce config, so the same source can yield different output in a different environment. chant restricts to synthesis because a lint pass keeps source to static data, and the same input always produces the same YAML.
- **True to the spec.** chant generates from the actual target resource model rather than an L2 or L3 abstraction layered above. The Kubernetes API and the CloudFormation spec map to chant objects 1:1 and stay typed.

While chant is not the first tool to compile configuration, chant compiles in a mainstream language, executes nothing, stays true to the real spec, and adds semantic rules that check whether a declaration is coherent rather than merely well-typed.

## Structural determinism

Kubernetes teams already fight non-determinism. Helm can call `now()`, `randAlphaNum()`, and `lookup` against the live cluster, so the same chart renders differently depending on when and where the render runs. The common defense reaches for Kustomize with no templating and no runtime functions and deterministic output. That defense works as determinism by avoidance, a discipline maintained by hand forever.

chant makes determinism a property of the build. A lint pass restricts source to literals, constants, and cross-resource references with no function calls in props and no control flow around resources. Anything that makes output depend on wall-clock time or live state becomes a build error that cannot merge. Running the file then equals reading static data, so the PR diff is the deploy delta. Apply time holds no surprises.

![Determinism: by avoidance vs. by enforcement](infra-compiler-diagrams/03-determinism-ladder.png)

## Semantic linting moves the catch left

The valuable check is not whether the YAML is valid but whether the declaration is coherent. chant knows the resource model of its target because the Kubernetes lexicon ships typed constructors and K8s-specific rules. chant catches the incoherent-but-valid class of error at author time as a red squiggle in the editor rather than a failed reconcile.

A compiler decides whether or not a bad reference or an invalid enum or a misconfigured probe makes it all the way to the cluster.

![A compiler moves the catch left](infra-compiler-diagrams/02-shift-left.png)

## Spec-true output means zero lock-in

chant invents no abstraction across clouds. Each lexicon stays faithful to its target spec. The Kubernetes lexicon emits standard manifests and the AWS lexicon generates from the CloudFormation resource spec. The output is the real API surface typed and linted, and never a chant-flavored wrapper.

chant slots under the existing stack so that nothing changes downstream. The reconciler keeps reconciling the same YAML as always. Walk-away cost is zero because dropping chant leaves the committed manifests working with nothing chant-specific to unwind.

![chant slots under the stack](infra-compiler-diagrams/05-slots-under.png)

## Lifecycles are opt-in

A compiler that stops at the artifact raises obvious questions about the drift and reconciliation and apply. chant treats those as opt-in per environment, with no authoritative state file required.

chant defaults to an observational state model where truth lives in the live system. chant snapshots what the cloud reports and that snapshot is only evidence for a diff, so deleting the snapshot between runs changes nothing. Ownership reads from a marker on the live resource rather than a stored record and the governance that matters stays in place. This yields a precise create/update/delete change-set and an audit trail and blast-radius limits, with no state file to lock and secure and protect from corruption.

A dial turns per environment. **observe** computes drift and changes nothing and alarms on the result. **reconcile** opens a PR that pulls live reality back into source. **authoritative** applies under a gate with deletes scoped to what chant owns. Dev can stay at observe while production applies behind an approval gate. Nothing ever forces an environment past its chosen position.

![Opt-in lifecycle with no authoritative state file](infra-compiler-diagrams/04-reconcile-superset.png)

## The deterministic core under the operational layer

chant sits underneath the operational layer as the part that stays deterministic and auditable, turning typed declarations into spec-native output and refusing anything non-deterministic along the way.
