// The home page's picker and the room pages under /chant/for/<id>/, from one
// file. Each target platform tile and each role is a room; the forge switch
// adds a line per forge. pages/for/[id].astro renders every room with the
// same sections in the same order: the lede, Works, Differs (per forge),
// First step, Proof and Then read. components/Picker.astro reads the same
// lists, so the picker and the rooms cannot disagree.
//
// A link's href is one of:
//   a page of this site, as its slug with an optional #anchor
//     ('guide/pull-request-ci', 'cli/audit#example');
//   a lexicon's docs section, as 'lexicons/<name>/' (generated from
//     lexicons/<name>/docs/pages into this site by scripts/build-docs.sh);
//   a full https:// address.
// scripts/check-rooms.mjs runs after `astro build` and fails the build when a
// room or the picker links a page or anchor that does not exist. A room's
// `examples` are directories in this repository; data/proof.mjs fails the
// build when one is missing, and counts each tile's lexicon examples from the
// filesystem, so every number on the page is read, never typed.

/** @typedef {{ label: string, href: string }} Link */

import { neverLine, pageUrl } from '../prompts.mjs';

/**
 * A room's prompt for its First step: it names the room's page and ends with
 * the never-line (scripts/lint-prompts.mjs checks both). `first.prompt` is
 * this, or `'setup'` for the setup prompt in prompts.mjs.
 */
const roomPrompt = (id, ...lines) => [`Read ${pageUrl(`for/${id}`)}.`, ...lines, neverLine].join('\n');

/** The setup steps for one lexicon, as a room prompt asks for them. */
const setUp = (lexicon) =>
	`Install it with \`npm install --save-dev @intentius/chant-lexicon-${lexicon}\`, run \`npx chant init . --lexicon ${lexicon}\`, and read every \`skills/*/SKILL.md\` it writes before you author anything.`;

const install = (lexicon, dir = 'my-infra') =>
	`npm install --save-dev @intentius/chant-lexicon-${lexicon}\nnpx chant init ${dir} --lexicon ${lexicon}`;

/** The target platforms: the tiles on the home page. `lexicons` are the directories under lexicons/ whose examples the Proof line counts. */
export const TILES = [
	{ id: 'aws', label: 'AWS', blurb: 'CloudFormation, EKS, Fargate', room: 'aws', lexicons: ['aws'] },
	{ id: 'kubernetes', label: 'Kubernetes', blurb: 'Manifests, Helm, Argo CD, Flux', room: 'kubernetes', lexicons: ['k8s', 'helm', 'k3d', 'k3s'] },
	{ id: 'gcp-azure', label: 'GCP and Azure', blurb: 'Config Connector, ARM, GKE, AKS', room: 'gcp-azure', lexicons: ['gcp', 'azure'] },
	{ id: 'ci', label: 'CI pipelines', blurb: 'GitHub Actions, GitLab CI, Forgejo', room: 'ci', lexicons: ['github', 'gitlab', 'forgejo'] },
	{ id: 'fly', label: 'Fly and containers', blurb: 'Fly Machines, Sprites, Docker', room: 'fly', lexicons: ['fly', 'docker', 'render'] },
	{ id: 'terraform-pulumi', label: 'Terraform and Pulumi', blurb: 'OpenTofu, choudoufu, plunge', room: 'terraform-pulumi', lexicons: ['terraform', 'pulumi'] },
];

/** The roles: the line of chips under the tiles. */
export const ROLES = [
	{ id: 'agents', label: 'I work with a coding agent', room: 'agents' },
	{ id: 'platform', label: 'I run a platform team', room: 'platform' },
	{ id: 'releases', label: 'I merge to trunk and curate releases', room: 'releases' },
	{ id: 'security', label: 'I review security', room: 'security' },
	{ id: 'evaluate', label: 'I am evaluating', room: 'evaluate' },
];

/** The forges chant generates pipelines for, and what differs on each (from guide/pull-request-ci and cli/audit). */
export const FORGES = [
	{
		id: 'github',
		label: 'GitHub',
		differs: [
			'`--generate github` writes the pull-request workflow under `.github/workflows/`, run on `pull_request` and on `push` to the target branch.',
			"Both jobs use the job's own `github.token`. On a pull request from a fork that token is read-only, so the plan note and the status are not posted.",
		],
	},
	{
		id: 'gitlab',
		label: 'GitLab',
		differs: [
			'`--generate gitlab` writes `.gitlab-ci.yml`, and `apply` runs one at a time per environment through `resource_group`.',
			'A CI job token cannot write merge request notes, so set a project access token with the `api` scope as the masked variable `CHANT_FORGE_TOKEN`.',
		],
	},
	{
		id: 'forgejo',
		label: 'Forgejo',
		differs: [
			'`--generate forgejo` writes the GitHub workflow in the Forgejo dialect under `.forgejo/workflows/`: the runner label, action references by URL, and no `permissions` block.',
			'Forgejo workflows are GitHub-dialect, so `chant audit` applies its GitHub rules to them.',
		],
	},
];

/**
 * The rooms, one per tile and role. `differs` adds lines to a forge's own (by
 * its id). `first.command` is `any` for every forge or one per forge id, in a
 * `sh` block; `first.note` comes before it. `first.prompt` is the step handed
 * to a coding agent: `'setup'` for the setup prompt, or a room prompt.
 */
export const ROOMS = [
	{
		id: 'aws',
		title: 'chant on AWS',
		lede: 'For a team whose infrastructure runs on AWS: typed CloudFormation in TypeScript, built to a standard template, and deployable to a local emulator before it reaches an account.',
		works: [
			'Typed CloudFormation resources and composites such as `LambdaNode`, built to a standard template by `chant build`',
			'Deploys to Floci, a local AWS emulator, through `awsApply`, with no account and no credentials',
			'An EKS cluster from the AWS lexicon and its workloads from the Kubernetes lexicon, in one project',
		],
		differs: {
			gitlab: ['The GitLab CI + AWS ALB tutorial deploys a multi-service Fargate application from GitLab CI.'],
		},
		first: {
			command: { any: install('aws') },
			link: { label: 'Quick Start', href: 'getting-started/quick-start' },
			prompt: roomPrompt(
				'aws',
				'Set up chant with the aws lexicon in this repository.',
				setUp('aws'),
				'Run `npx chant build` and `npx chant lint` until both pass, and open a pull request with the result. Deploy only to Floci, the local AWS emulator, and only when I ask.',
			),
		},
		examples: ['examples/local-cloud-trio', 'examples/k8s-eks-microservice', 'examples/gitlab-aws-alb-infra'],
		tasks: [
			{ label: 'Quick Start', href: 'getting-started/quick-start' },
			{ label: 'Local testing on AWS', href: 'local-testing/aws' },
			{ label: 'AWS EKS + Kubernetes', href: 'tutorials/eks-kubernetes' },
			{ label: 'GitLab CI + AWS ALB', href: 'tutorials/gitlab-aws-alb' },
			{ label: 'Move one Terraform resource to a native lexicon', href: 'tutorials/terraform-carve-out' },
		],
		background: [
			{ label: 'Lexicons', href: 'lexicons/overview' },
			{ label: 'TypeScript as Data', href: 'concepts/typescript-as-data' },
		],
		reference: [
			{ label: 'AWS CloudFormation lexicon', href: 'lexicons/aws/' },
			{ label: 'Parameters & Outputs', href: 'getting-started/parameters-and-outputs' },
			{ label: 'chant build', href: 'cli/build' },
		],
	},
	{
		id: 'kubernetes',
		title: 'chant on Kubernetes',
		lede: 'For a team that ships to Kubernetes: manifests and Helm charts from TypeScript, GitOps through Argo CD or Flux, and a local k3d cluster to try it on.',
		works: [
			'Kubernetes manifests and Helm charts from TypeScript, in the formats kubectl and helm read',
			'GitOps on-ramps for Argo CD (`ArgoAppFor`) and Flux CD (`FluxGitSource`, `FluxAppFor`)',
			'Drift reported against the composite argument and source line that set the field, with a k3d demo you can run',
		],
		differs: {},
		first: {
			command: { any: install('k8s') },
			link: { label: 'Drift Back to Source', href: 'guide/drift-to-source' },
			prompt: roomPrompt(
				'kubernetes',
				'Set up chant with the k8s lexicon in this repository, and the helm lexicon as well if it holds Helm charts.',
				setUp('k8s'),
				'Run `npx chant build` and `npx chant lint` until both pass, and open a pull request with the result. Apply manifests only to a local k3d cluster, and only when I ask.',
			),
		},
		examples: ['examples/getting-started', 'examples/k8s-drift-to-source', 'examples/argo-cd-gke', 'examples/flux-apps'],
		tasks: [
			{ label: 'Drift Back to Source', href: 'guide/drift-to-source' },
			{ label: 'Argo CD on GKE', href: 'tutorials/argo-cd-gke' },
			{ label: 'Flux CD Self-Hosted', href: 'tutorials/flux-apps' },
			{ label: 'Agent Observability on k3d', href: 'tutorials/agent-observability' },
		],
		background: [
			{ label: 'Drift Detection', href: 'concepts/drift-detection' },
			{ label: 'Lifecycle Models', href: 'concepts/lifecycle-models' },
		],
		reference: [
			{ label: 'Kubernetes lexicon', href: 'lexicons/k8s/' },
			{ label: 'Helm Charts lexicon', href: 'lexicons/helm/' },
			{ label: 'k3d lexicon', href: 'lexicons/k3d/' },
		],
	},
	{
		id: 'gcp-azure',
		title: 'chant on GCP and Azure',
		lede: 'For a team on Google Cloud or Azure: Config Connector resources and ARM templates from TypeScript, with a local emulator for each cloud.',
		works: [
			'GCP Config Connector resources and Azure ARM templates from TypeScript',
			'Local deploys to floci-gcp through `gcpApply` and to floci-az through `azApply`, with no account',
			'GKE and AKS clusters with their workloads from the Kubernetes lexicon, in one project',
		],
		differs: {},
		first: {
			note: 'For Azure, use `azure` in place of `gcp`.',
			command: { any: install('gcp') },
			link: { label: 'Local Testing', href: 'local-testing/overview' },
			prompt: roomPrompt(
				'gcp-azure',
				'Set up chant in this repository with the gcp lexicon, or the azure lexicon when the repository targets Azure; use `azure` in place of `gcp` below.',
				setUp('gcp'),
				'Run `npx chant build` and `npx chant lint` until both pass, and open a pull request with the result. Deploy only to the local emulator (floci-gcp or floci-az), and only when I ask.',
			),
		},
		examples: ['examples/local-cloud-trio', 'examples/k8s-gke-microservice', 'examples/k8s-aks-microservice', 'examples/cockroachdb-multi-region-gke'],
		tasks: [
			{ label: 'Local testing on GCP', href: 'local-testing/gcp' },
			{ label: 'Local testing on Azure', href: 'local-testing/azure' },
			{ label: 'GCP GKE + Kubernetes', href: 'tutorials/gke-kubernetes' },
			{ label: 'Azure AKS + Kubernetes', href: 'tutorials/aks-kubernetes' },
			{ label: 'CockroachDB Multi-Region', href: 'tutorials/cockroachdb-multi-region' },
			{ label: 'Ray + KubeRay on GKE', href: 'tutorials/ray-kuberay-gke' },
		],
		background: [
			{ label: 'Choosing Your Deployment Model', href: 'concepts/deployment-paths' },
			{ label: 'Where Values Come From', href: 'concepts/where-values-come-from' },
		],
		reference: [
			{ label: 'GCP Config Connector lexicon', href: 'lexicons/gcp/' },
			{ label: 'Azure ARM lexicon', href: 'lexicons/azure/' },
		],
	},
	{
		id: 'ci',
		title: 'chant for CI pipelines',
		lede: 'For a team that owns its pipelines: workflows for GitHub Actions, GitLab CI and Forgejo Actions from TypeScript, a generated pull-request pipeline, and an audit of the pipelines you already have.',
		works: [
			'Workflows for GitHub Actions, GitLab CI and Forgejo Actions from TypeScript',
			'A generated pull-request pipeline that plans what a change reaches, posts the plan, and on merge records it for a release to deploy; applying on merge is opt-in',
			"`chant audit` reads a repository's existing pipelines and reports security findings, with a diff for each mechanical fix",
			'`chant migrate` translates a GitHub Actions workflow into GitLab CI',
			"Pipelines are compiled to the forge's own YAML at build time, so CI runs no extra engine and forge tooling such as required checks keeps working",
		],
		differs: {},
		first: {
			command: { github: install('github', 'my-pipelines'), gitlab: install('gitlab', 'my-pipelines'), forgejo: install('forgejo', 'my-pipelines') },
			link: { label: 'Generated CI for Pull Requests', href: 'guide/pull-request-ci' },
			prompt: roomPrompt(
				'ci',
				"Set up chant for this repository's pipelines with the lexicon of its forge: github, gitlab or forgejo. Use that name in place of `github` below.",
				setUp('github'),
				'Run `npx chant audit .` over the pipelines the repository has now, and list its findings in the pull request description.',
				'Run `npx chant build` and `npx chant lint` until both pass, and open a pull request with the result.',
			),
		},
		examples: ['examples/github-pr-preview', 'examples/gitlab-aws-alb-services'],
		tasks: [
			{ label: 'Generated CI for Pull Requests', href: 'guide/pull-request-ci' },
			{ label: 'Apply on Merge (opt-in)', href: 'guide/apply-on-merge' },
			{ label: 'Move off Apply on Merge', href: 'guide/move-off-apply-on-merge' },
			{ label: 'Per-PR Preview Environments', href: 'tutorials/github-pr-preview' },
			{ label: 'GitLab CI + AWS ALB', href: 'tutorials/gitlab-aws-alb' },
		],
		background: [
			{ label: 'Components', href: 'concepts/components' },
			{ label: 'Pipeline engines', href: 'concepts/comparison#pipeline-engines' },
		],
		reference: [
			{ label: 'chant audit', href: 'cli/audit' },
			{ label: 'chant migrate', href: 'cli/migrate' },
			{ label: 'Audit rules reference', href: 'lint-rules/audit-rules' },
			{ label: 'GitHub Actions lexicon', href: 'lexicons/github/' },
			{ label: 'GitLab CI/CD lexicon', href: 'lexicons/gitlab/' },
			{ label: 'Forgejo Actions lexicon', href: 'lexicons/forgejo/' },
		],
	},
	{
		id: 'fly',
		title: 'chant on Fly and containers',
		lede: 'For a team that runs on Fly Machines and containers: Apps and Machines applied straight to the Machines API, Sprites for sandboxes, and Docker files from the same TypeScript.',
		works: [
			'Fly Apps and Machines applied straight to the Machines API by `flyApply`, with no flyctl and no state file',
			'The whole deploy offline against the mudflaps emulator first, then against real Fly by dropping one override',
			'Sprites as disposable build sandboxes and agent workers, rewound to a checkpoint when a step fails',
			'Docker Compose services and multi-stage Dockerfiles from TypeScript',
		],
		differs: {},
		first: {
			command: { any: install('fly', 'my-app') },
			link: { label: 'Deploy Fly Machines Offline', href: 'tutorials/local-fly' },
			prompt: roomPrompt(
				'fly',
				'Set up chant with the fly lexicon in this repository.',
				setUp('fly'),
				'Run `npx chant build` and `npx chant lint` until both pass, and open a pull request with the result. Deploy only to the mudflaps emulator, and only when I ask.',
			),
		},
		examples: ['examples/local-fly', 'examples/fly-reconcile', 'examples/fly-deploy-rollback', 'examples/sprites-build-sandbox'],
		tasks: [
			{ label: 'Deploy Fly Machines Offline', href: 'tutorials/local-fly' },
			{ label: 'Reconcile Fly Machines', href: 'tutorials/fly-machines-reconcile' },
			{ label: 'Fly Deploy with Checkpoint Rollback', href: 'tutorials/fly-deploy-rollback' },
			{ label: 'Disposable Build Sandbox on Sprites', href: 'tutorials/sprites-build-sandbox' },
			{ label: 'Managed Agents Worker on Sprites', href: 'tutorials/sprites-managed-agent-worker' },
		],
		background: [{ label: 'Reconciliation', href: 'concepts/reconciliation' }],
		reference: [
			{ label: 'Fly Machines lexicon', href: 'lexicons/fly/' },
			{ label: 'Docker lexicon', href: 'lexicons/docker/' },
			{ label: 'Render lexicon', href: 'lexicons/render/' },
		],
	},
	{
		id: 'terraform-pulumi',
		title: 'chant with Terraform, OpenTofu and Pulumi',
		lede: 'For a team that runs Terraform or OpenTofu roots, or Pulumi programs: keep them as they are, add them to a chant workspace, and run them on choudoufu or plunge when you want ownership markers on the resources.',
		works: [
			'The terraform lexicon reads your `.tf` roots as they are, lints them, and plans and applies them through terraform, tofu or choudoufu',
			'The pulumi lexicon reads a Pulumi program from its stack export and previews, and `pulumi up` still applies it',
			'choudoufu, an OpenTofu fork, and plunge, a Pulumi fork, keep each resource\'s ownership as a marker on the resource itself',
		],
		differs: {},
		first: {
			note: 'For a Pulumi program, install `@intentius/chant-lexicon-pulumi` instead.',
			command: { any: 'npm install --save-dev @intentius/chant-lexicon-terraform' },
			link: { label: 'Terraform getting started', href: 'lexicons/terraform/getting-started' },
			prompt: roomPrompt(
				'terraform-pulumi',
				'Add the Terraform or OpenTofu roots in this repository, or its Pulumi program, to a chant workspace.',
				'For Terraform or OpenTofu, follow https://intentius.io/chant/lexicons/terraform/getting-started/. For Pulumi, follow https://intentius.io/chant/lexicons/pulumi/getting-started/.',
				'Run `npx chant build` until it passes, and open a pull request with the config. Do not run `terraform apply`, `tofu apply` or `pulumi up`.',
			),
		},
		examples: ['lexicons/terraform/examples/getting-started', 'lexicons/pulumi/examples/workspace-member', 'lexicons/pulumi/examples/plunge-member'],
		tasks: [
			{ label: 'Terraform getting started', href: 'lexicons/terraform/getting-started' },
			{ label: 'Pulumi getting started', href: 'lexicons/pulumi/getting-started' },
			{ label: 'Run a root on choudoufu', href: 'lexicons/terraform/ops#choudoufu' },
			{ label: 'A member on plunge', href: 'lexicons/pulumi/plunge' },
		],
		background: [
			{ label: 'Works with', href: 'concepts/comparison' },
			{ label: 'Lifecycle Models', href: 'concepts/lifecycle-models' },
		],
		reference: [
			{ label: 'Terraform lexicon', href: 'lexicons/terraform/' },
			{ label: 'Pulumi lexicon', href: 'lexicons/pulumi/' },
			{ label: 'Workspace kinds', href: 'reference/workspace-kinds' },
		],
	},
	{
		id: 'agents',
		title: 'chant with a coding agent',
		lede: 'For a team that hands infrastructure work to a coding agent: one prompt sets chant up, and the project carries the playbooks and tools the agent reads.',
		works: [
			'A copy-paste setup prompt on Agents Start Here, which installs a lexicon and scaffolds the project',
			'`chant init` writes a `skills/` directory of playbooks from each lexicon and a `.mcp.json` that registers the chant MCP server',
			'A page that describes a task can carry a prompt for the agent under its title, and `llms.txt` lists every page',
			'`chant audit --agents` checks the agent setup on the machine: instruction files, MCP servers, skills, plugins and tool permissions',
		],
		differs: {},
		first: {
			note: 'Or paste the prompt from Agents Start Here and let the agent pick the lexicon.',
			command: { any: install('aws', '.') },
			link: { label: 'Agents Start Here', href: 'agents' },
			prompt: 'setup',
		},
		examples: ['examples/getting-started', 'examples/alert-triage'],
		tasks: [{ label: 'Agents Start Here', href: 'agents' }],
		background: [
			{ label: 'Agent Integration', href: 'guide/agent-integration' },
			{ label: 'Ops as Teammates', href: 'concepts/durable-workflows' },
		],
		reference: [
			{ label: 'chant serve mcp', href: 'cli/mcp' },
			{ label: 'chant audit', href: 'cli/audit' },
		],
	},
	{
		id: 'platform',
		title: 'chant for a platform team',
		lede: 'For a team that sets the rules other teams build within: policy as project code, shared defaults as plain functions, and rollouts one environment at a time behind a gate.',
		works: [
			'Policy checks written in the project that read the environment, such as no public buckets in prod',
			"Presets and composite resources that carry a team's defaults as plain functions",
			'Op waves that apply to each environment, or each target in a set, one wave at a time behind one gate',
			'Components run by one generic orchestrator, so a new component adds no new pipeline',
		],
		differs: {},
		first: {
			note: 'Policy runs during `chant build`; pass the environment with `--env`.',
			command: { any: 'npx chant build src --env prod' },
			link: { label: 'Organizational Policy', href: 'guide/organizational-policy' },
			prompt: roomPrompt(
				'platform',
				`Following ${pageUrl('guide/organizational-policy')}, write the policy checks I describe as project code in this chant project.`,
				'Run `npx chant build src --env <env>` for each environment I name, and show me what each check reports.',
				'Open a pull request with the checks.',
			),
		},
		examples: ['examples/fan-out-estate', 'examples/components-aws-e2e'],
		tasks: [
			{ label: 'Organizational Policy', href: 'guide/organizational-policy' },
			{ label: 'Presets', href: 'guide/presets' },
			{ label: 'Composite Resources', href: 'guide/composite-resources' },
			{ label: 'Multi-Stack Projects', href: 'guide/multi-stack' },
			{ label: 'Layered Configuration', href: 'guide/layered-configuration' },
			{ label: 'Op Waves', href: 'guide/op-waves' },
		],
		background: [
			{ label: 'State and Governance', href: 'concepts/governance' },
			{ label: 'Components', href: 'concepts/components' },
		],
		reference: [
			{ label: 'Config File', href: 'configuration/config-file' },
			{ label: 'Lint rules', href: 'lint-rules/overview' },
		],
	},
	{
		id: 'releases',
		title: 'chant for teams that merge to trunk and curate releases',
		lede: 'For a team that merges every change to one branch without fear: a merge records the plan and deploys nothing, CI marks the commits that passed as git tags, a person cuts a release from the green commit they choose, and the release moves through each environment behind a gate bound to what changes there.',
		works: [
			'`chant ci init --workflow trunk-curated` sets the workspace up: `ci.workflow`, `ci.green`, environments, component stubs, and the plan, record, tick and publish jobs',
			'A merge records the approved plan (`chant ci run record`) and deploys nothing; applying on merge is an opt-in',
			'`chant ci tick` tags each trunk commit that passed the required CI phases `ci/green/<sha>`, and revokes the tag when a re-run fails',
			'`chant release cut` compiles one green commit for every environment once, and `chant release publish` ships it from CI with provenance',
			'`chant components promote --release` deploys the recorded templates and artifacts in promotion order, each environment behind a gate that binds the release, the environment and the change set',
			'Feature flags as reviewed workspace records, read by the build, so unfinished work merges switched off',
			'Rollback to an earlier release, revocation read from the tags, retention, and DORA metrics from the same records',
		],
		differs: {
			gitlab: ['GitLab has no check-run reader, so set `ci.green.source` to `runs`: each phase is a chant Op run with a runner key, and the tick goes in the pipeline after them.'],
			forgejo: ['Forgejo has no check-run reader, so set `ci.green.source` to `runs`: each phase is a chant Op run with a runner key, and the tick goes in the pipeline after them.'],
		},
		first: {
			note: 'Run it in a repository with a `chant.workspace.json`; without `--yes` it prints the diff and writes nothing.',
			command: { any: 'npx chant ci init --workflow trunk-curated\nnpx chant workspace check' },
			link: { label: 'Set Up Trunk with Curated Releases', href: 'guide/trunk-curated-setup' },
			prompt: roomPrompt(
				'releases',
				`Following ${pageUrl('guide/trunk-curated-setup')}, run \`npx chant ci init --workflow trunk-curated\`, show me the diff it prints, and once I agree run it again with \`--yes\`.`,
				'Fill in the component stubs it writes from what this repository builds and deploys, run `npx chant workspace check` until it reports nothing for WSP151 but what needs me, and open a pull request with the changes.',
			),
		},
		examples: ['examples/trunk-curated-floci', 'examples/components-aws-e2e'],
		tasks: [
			{ label: 'Set Up Trunk with Curated Releases', href: 'guide/trunk-curated-setup' },
			{ label: 'From Zero to a Promoted Release', href: 'tutorials/zero-to-promoted-release' },
			{ label: 'Tag Green Commits', href: 'guide/green-commits' },
			{ label: 'Link commits to work items', href: 'guide/work-items#link-commits-to-work-items' },
			{ label: 'Curate a Release', href: 'guide/curate-a-release' },
			{ label: 'Land Without a Pull Request', href: 'guide/land-without-a-pull-request' },
			{ label: 'Compose a Release', href: 'guide/compose-a-release' },
			{ label: 'Release from Your Workstation', href: 'guide/release-from-workstation' },
			{ label: 'Promote a Release', href: 'guide/promote-a-release' },
			{ label: 'Feature Flags', href: 'guide/feature-flags' },
			{ label: 'Prune chant/lifecycle', href: 'guide/prune-lifecycle' },
			{ label: 'Read Delivery Metrics', href: 'guide/delivery-metrics' },
		],
		background: [
			{ label: 'Trunk and Releases', href: 'concepts/trunk-and-releases' },
			{ label: 'Build-Time Parameters', href: 'concepts/build-time-parameters' },
			{ label: 'State and Governance', href: 'concepts/governance' },
		],
		reference: [
			{ label: 'chant ci', href: 'cli/ci' },
			{ label: 'chant release', href: 'cli/release' },
			{ label: 'chant components promote', href: 'cli/components#components-promote' },
			{ label: 'chant change-set', href: 'cli/change-set' },
			{ label: 'chant workspace status', href: 'cli/workspace-status' },
			{ label: 'chant workspace metrics', href: 'cli/workspace-metrics' },
			{ label: 'chant lifecycle gc', href: 'cli/lifecycle#lifecycle-gc' },
			{ label: 'Workspace Declaration: CI', href: 'reference/workspace-declaration#ci' },
			{ label: 'CI Workflows', href: 'reference/ci-workflows' },
		],
	},
	{
		id: 'security',
		title: 'chant for security review',
		lede: 'For someone who signs off on what chant runs and what it produces: where it reaches the network, what it signs, and what it checks.',
		works: [
			'Network Egress lists every module that can reach the network and the command that reaches it, and a guard test holds the offline phases to that list',
			"SBOM, SLSA provenance and keyless signing attached to a component's artifact, with a `verify` gate before apply",
			'`chant audit` runs the security rules over a repository chant did not generate: pipelines, manifests, templates and likely secrets',
			'Lint rules that check meaning, such as whether a resource is encrypted, across lexicons',
		],
		differs: {},
		first: {
			command: { any: 'npx @intentius/chant audit .' },
			link: { label: 'chant audit', href: 'cli/audit' },
			prompt: roomPrompt(
				'security',
				'Run `npx @intentius/chant audit . --tier merge-worthy` in this repository, and report each finding with its file, its rule and the fix it suggests.',
				'Read only: change no file and open no pull request.',
			),
		},
		examples: ['examples/supply-chain'],
		tasks: [
			{ label: 'Linting & Type-Checking', href: 'guide/linting' },
			{ label: 'Organizational Policy', href: 'guide/organizational-policy' },
		],
		background: [
			{ label: 'Supply-Chain Attestations', href: 'components/supply-chain' },
			{ label: 'State and Governance', href: 'concepts/governance' },
		],
		reference: [
			{ label: 'Network Egress', href: 'reference/network-egress' },
			{ label: 'Audit rules reference', href: 'lint-rules/audit-rules' },
			{ label: 'Attestation Reference', href: 'components/attestation-reference' },
			{ label: 'Sandboxed Execution', href: 'architecture/sandbox' },
		],
	},
	{
		id: 'evaluate',
		title: 'Evaluating chant',
		lede: 'For someone deciding whether chant fits: how chant sits next to the tools you run, and a project to try on your own machine with no cloud account.',
		works: [
			'A getting-started example that teaches chant in levels, starting with build, lint and list on nothing but Node',
			'Local emulators for AWS, Azure, GCP and Fly, so a deploy runs with no account',
			'Plain CloudFormation, Kubernetes YAML and workflow files, which keep working if you stop using chant',
		],
		differs: {},
		first: {
			command: { any: 'git clone https://github.com/INTENTIUS/chant\ncd chant/examples/getting-started\nnpm install\nnpm run build' },
			link: { label: 'Quick Start', href: 'getting-started/quick-start' },
			prompt: roomPrompt(
				'evaluate',
				'In a new directory, clone https://github.com/INTENTIUS/chant, and in `examples/getting-started` run `npm install` and `npm run build`.',
				'Show me the output, and tell me what the example built and where it wrote it. Change nothing outside the new directory.',
			),
		},
		examples: ['examples/getting-started', 'examples/local-cloud-trio', 'examples/local-op-quickstart'],
		tasks: [
			{ label: 'Quick Start', href: 'getting-started/quick-start' },
			{ label: 'Local Testing', href: 'local-testing/overview' },
		],
		background: [
			{ label: 'Introduction', href: 'getting-started/introduction' },
			{ label: 'Overview', href: 'concepts/overview' },
			{ label: 'Works with', href: 'concepts/comparison' },
			{ label: 'Philosophy', href: 'concepts/philosophy' },
		],
		reference: [
			{ label: 'Project Structure', href: 'getting-started/project-structure' },
			{ label: 'CLI overview', href: 'cli/overview' },
		],
	},
];

/** Every room link, with the room it sits in, for the post-build check. */
export function roomLinks() {
	const out = [];
	for (const r of ROOMS) {
		for (const l of [r.first.link, ...r.tasks, ...r.background, ...r.reference]) out.push({ room: r.id, ...l });
	}
	return out;
}

/** A room by id; throws on one that does not exist. */
export function room(id) {
	const r = ROOMS.find((x) => x.id === id);
	if (!r) throw new Error(`docs/src/data/rooms.mjs: no room ${id}`);
	return r;
}

/** Each tile and role names a room; each room's differs names a forge. Throws on the first that does not. */
export function checkRooms() {
	for (const x of [...TILES, ...ROLES]) room(x.room);
	for (const r of ROOMS) {
		for (const id of Object.keys(r.differs)) {
			if (!FORGES.some((f) => f.id === id)) throw new Error(`docs/src/data/rooms.mjs: room ${r.id} has differs for ${id}, which is not a forge`);
		}
		const cmd = r.first.command;
		if (!cmd.any && !FORGES.every((f) => cmd[f.id])) throw new Error(`docs/src/data/rooms.mjs: room ${r.id} needs first.command.any or one per forge`);
		if (typeof r.first.prompt !== 'string' || !r.first.prompt.trim()) throw new Error(`docs/src/data/rooms.mjs: room ${r.id} needs first.prompt: 'setup', or a prompt that names the room's page`);
	}
}
