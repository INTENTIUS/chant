// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeBaseUrl from '../packages/core/src/codegen/rehype-base-url.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://intentius.io',
	base: '/chant',
	markdown: {
		rehypePlugins: [[rehypeBaseUrl, { base: '/chant' }]],
	},
	redirects: {
		// Destination is base-prefixed: Astro's own redirect renderer emits this
		// path verbatim into the meta-refresh/canonical of the generated static
		// page (unlike Starlight's internal nav, it does not resolve `base`
		// itself), so an unprefixed target 404s once the site is served under
		// `/chant`.
		'/getting-started/configuration/': '/chant/configuration/config-file/',
	},
	integrations: [
		starlight({
			title: 'chant',
			customCss: ['./src/styles/custom.css'],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/intentius/chant' }],
			plugins: [
				// Ships /llms.txt and /llms-full.txt from the same content at build
				// time — chant #1220. No page for these; starlight-llms-txt injects
				// its own Astro routes and renders every Starlight doc to Markdown.
				starlightLlmsTxt({
					description:
						'chant is a TypeScript-first infrastructure tool: typed resources in, spec-native output (CloudFormation, GitLab CI, Kubernetes YAML, and more) out, validated by semantic lint rules, with an optional durable deployment lifecycle on top.',
					details:
						'- Agents: start at /agents/ for a copy-paste setup prompt, then /guide/agent-integration/ for the skills, MCP tools, and Ops surfaces available after `chant init`.\n- No YAML, no DSL: infrastructure is exported TypeScript, type-checked against a provider lexicon.\n- No authoritative state file: `chant build` synthesizes deterministically from source; drift and apply are computed against the live system.',
					// The agent prompt page is the entry point machine readers want
					// first — surface it ahead of the human getting-started page.
					promote: ['agents', 'index*'],
				}),
			],
			sidebar: [
				// Grouped by Diátaxis quadrant (https://diataxis.fr), chant #1731.
				// Every page carries a matching `diataxis` frontmatter field;
				// scripts/check-docs-diataxis.mjs fails when the two disagree.
				{
					label: 'Tutorials',
					items: [
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
						{ label: 'Alert Triage (local)', slug: 'tutorials/alert-triage-local' },
						{ label: 'Carve out of Terraform', slug: 'tutorials/terraform-carve-out' },
						{
							label: 'Fly',
							items: [
								{ label: 'Deploy Fly Machines Offline', slug: 'tutorials/local-fly' },
								{ label: 'Reconcile Fly Machines', slug: 'tutorials/fly-machines-reconcile' },
								{ label: 'Fly Deploy with Checkpoint Rollback', slug: 'tutorials/fly-deploy-rollback' },
								{ label: 'Durable Fly Deploy on Temporal', slug: 'tutorials/fly-durable-deploy' },
								{ label: 'Managed Agents Worker on Sprites', slug: 'tutorials/sprites-managed-agent-worker' },
								{ label: 'Disposable Build Sandbox on Sprites', slug: 'tutorials/sprites-build-sandbox' },
							],
						},
						{ label: 'GCP GKE + Kubernetes', slug: 'tutorials/gke-kubernetes' },
						{ label: 'GKE Composites', link: '/lexicons/k8s/gke-composites/' },
						{ label: 'AWS EKS + Kubernetes', slug: 'tutorials/eks-kubernetes' },
						{ label: 'EKS Composites', link: '/lexicons/k8s/eks-composites/' },
						{ label: 'Azure AKS + Kubernetes', slug: 'tutorials/aks-kubernetes' },
						{ label: 'AKS Composites', link: '/lexicons/k8s/aks-composites/' },
						{ label: 'GitLab CI + AWS ALB', slug: 'tutorials/gitlab-aws-alb' },
						{ label: 'Per-PR Preview Environments', slug: 'tutorials/github-pr-preview' },
						{ label: 'CockroachDB Multi-Region', slug: 'tutorials/cockroachdb-multi-region' },
						{ label: 'GitLab Cells on GKE', slug: 'tutorials/gitlab-cells' },
						{ label: 'Durable Infrastructure Workflows', slug: 'tutorials/temporal-crdb-deploy' },
						{ label: 'Fargate + Lucene/Solr + EFS', slug: 'tutorials/fargate-lucene-efs-solr' },
						{ label: 'Ray + KubeRay on GKE', slug: 'tutorials/ray-kuberay-gke' },
						{ label: 'Argo CD on GKE', slug: 'tutorials/argo-cd-gke' },
						{ label: 'Argo CD Composites', link: '/lexicons/k8s/argo-composites/' },
						{ label: 'Flux CD Self-Hosted', slug: 'tutorials/flux-apps' },
						{ label: 'Flux Composites', link: '/lexicons/k8s/flux-composites/' },
					],
				},
				{
					label: 'How-to guides',
					items: [
						{ label: 'Agents Start Here', slug: 'agents' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{
							label: 'Author resources',
							items: [
								{ label: 'Writing Resources', slug: 'guide/writing-resources' },
								{ label: 'Resource Naming', slug: 'guide/resource-naming' },
								{ label: 'Cross-File References', slug: 'guide/cross-file-references' },
								{ label: 'Parameters & Outputs', slug: 'getting-started/parameters-and-outputs' },
								{ label: 'Composite Resources', slug: 'guide/composite-resources' },
								{ label: 'Presets', slug: 'guide/presets' },
								{ label: 'Layered Configuration', slug: 'guide/layered-configuration' },
								{ label: 'Multi-Stack Projects', slug: 'guide/multi-stack' },
								{ label: 'Importing Templates', slug: 'guide/importing-templates' },
								{ label: 'Live Import', slug: 'guide/live-import' },
								{ label: 'Managing Lexicons', slug: 'guide/managing-lexicons' },
							],
						},
						{
							label: 'Lint and policy',
							items: [
								{ label: 'Linting & Type-Checking', slug: 'guide/linting' },
								{ label: 'Organizational Policy', slug: 'guide/organizational-policy' },
								{ label: 'Custom Rules', slug: 'lint-rules/custom-rules' },
								{ label: 'Auto-Fix', slug: 'lint-rules/auto-fix' },
							],
						},
						{
							label: 'Build and run',
							items: [
								{ label: 'Building', slug: 'guide/building' },
								{ label: 'Watch Mode', slug: 'configuration/watch' },
								{ label: 'Ops', slug: 'guide/ops' },
								{ label: 'Watching Lifecycle', slug: 'guide/watching-lifecycle' },
								{ label: 'Reconciling Lifecycle', slug: 'guide/reconciling-lifecycle' },
							],
						},
						{
							label: 'Components',
							items: [
								{ label: 'Wiring Components', slug: 'components/wiring-howto' },
							],
						},
						{
							label: 'Local testing',
							items: [
								{ label: 'Overview', slug: 'local-testing/overview' },
								{ label: 'AWS (Floci)', slug: 'local-testing/aws' },
								{ label: 'Azure (floci-az)', slug: 'local-testing/azure' },
								{ label: 'GCP (floci-gcp)', slug: 'local-testing/gcp' },
								{ label: 'Test Harness (vitest)', slug: 'local-testing/testing-harness' },
							],
						},
						{
							label: 'Extend chant',
							collapsed: true,
							badge: { text: 'Plugin Dev', variant: 'tip' },
							items: [
								{ label: 'Onboarding Skill (for agents)', slug: 'lexicon-authoring/onboarding-skill' },
								{ label: 'Scaffold a Lexicon', slug: 'lexicon-authoring/scaffold' },
								{ label: 'Implement Generate', slug: 'lexicon-authoring/generate' },
								{ label: 'Add a Third-Party CRD', slug: 'lexicon-authoring/crd-sources' },
								{ label: 'Create a Serializer', slug: 'lexicon-authoring/serializer' },
								{ label: 'Implementing Observation', slug: 'lexicon-authoring/observation' },
								{ label: 'Implementing Live Export', slug: 'lexicon-authoring/live-export' },
								{ label: 'Declaring a Local Emulator', slug: 'lexicon-authoring/emulator' },
								{ label: 'Write Lint Rules', slug: 'lexicon-authoring/lint-rules' },
								{ label: 'LSP & MCP Providers', slug: 'lexicon-authoring/lsp-mcp' },
								{ label: 'Post-Synth Checks', slug: 'lexicon-authoring/post-synth-checks' },
								{ label: 'Testing', slug: 'lexicon-authoring/testing' },
								{ label: 'Implementing Import', slug: 'lexicon-authoring/importing' },
								{ label: 'Package & Publish', slug: 'lexicon-authoring/package' },
								{ label: 'CI & Distribution', slug: 'lexicon-authoring/ci-integration' },
								{ label: 'Docs Site', slug: 'lexicon-authoring/docs-site' },
							],
						},
						{
							label: 'Contribute',
							collapsed: true,
							badge: { text: 'Core Dev', variant: 'note' },
							items: [
								{ label: 'Development Setup', slug: 'contributing/development' },
								{ label: 'Contributing a Lifecycle', slug: 'contributing/lifecycles' },
								{ label: 'E2E Testing', slug: 'contributing/e2e-testing' },
							],
						},
						{
							label: 'Troubleshoot',
							items: [
								{ label: 'Common Errors', slug: 'troubleshooting/common-errors' },
								{ label: 'Lexicon Issues', slug: 'troubleshooting/lexicon-issues' },
								{ label: 'Type Errors', slug: 'troubleshooting/type-errors' },
							],
						},
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Project Structure', slug: 'getting-started/project-structure' },
						{
							label: 'CLI',
							items: [
								{ label: 'Overview', slug: 'cli/overview' },
								{ label: 'init', slug: 'cli/init' },
								{ label: 'build', slug: 'cli/build' },
								{ label: 'lint', slug: 'cli/lint' },
								{ label: 'list', slug: 'cli/list' },
								{ label: 'describe', slug: 'cli/describe' },
								{ label: 'search', slug: 'cli/search' },
								{ label: 'vendor', slug: 'cli/vendor' },
								{ label: 'import', slug: 'cli/import' },
								{ label: 'carve advise', slug: 'cli/carve' },
								{ label: 'carve out (emit/bridge/apply)', slug: 'cli/carve-out' },
								{ label: 'audit', slug: 'cli/audit' },
								{ label: 'migrate', slug: 'cli/migrate' },
								{ label: 'update', slug: 'cli/update' },
								{ label: 'doctor', slug: 'cli/doctor' },
								{ label: 'run', slug: 'cli/run' },
								{ label: 'graph', slug: 'cli/graph' },
								{ label: 'lifecycle', slug: 'cli/lifecycle' },
								{ label: 'scenario', slug: 'cli/scenario' },
								{ label: 'components', slug: 'cli/components' },
								{ label: 'emulator', slug: 'cli/emulator' },
								{ label: 'serve lsp', slug: 'cli/lsp' },
								{ label: 'serve mcp', slug: 'cli/mcp' },
								{
									label: 'dev',
									items: [
										{ label: 'init lexicon', slug: 'cli/init-lexicon' },
										{ label: 'dev generate', slug: 'cli/generate' },
										{ label: 'dev publish', slug: 'cli/dev-publish' },
										{ label: 'dev onboard', slug: 'cli/onboard' },
										{ label: 'dev check-lexicon', slug: 'cli/check-lexicon' },
										{ label: 'dev surface-diff', slug: 'cli/surface-diff' },
									],
								},
							],
						},
						{
							label: 'Configuration',
							items: [
								{ label: 'Config File', slug: 'configuration/config-file' },
								{ label: 'TypeScript Configuration', slug: 'configuration/tsconfig' },
							],
						},
						{
							label: 'Ops and lifecycle',
							items: [
								{ label: 'Ops Reference', slug: 'guide/ops-reference' },
							],
						},
						{
							label: 'Lint rules',
							items: [
								{ label: 'Overview', slug: 'lint-rules/overview' },
								{ label: 'Audit Rules Reference', slug: 'lint-rules/audit-rules' },
								{ label: 'Evaluability (EVL)', slug: 'lint-rules/evaluability' },
								{ label: 'Style', slug: 'lint-rules/style' },
								{ label: 'Cross-File', slug: 'lint-rules/cross-file' },
								{ label: 'Correctness', slug: 'lint-rules/correctness' },
								{ label: 'Composite', slug: 'lint-rules/composite' },
								{ label: 'Composition (COMP)', slug: 'lint-rules/composition' },
								{ label: 'Configuration', slug: 'lint-rules/configuration' },
								{ label: 'Disable Directives', slug: 'lint-rules/disable-directives' },
							],
						},
						{
							label: 'Serialization',
							items: [
								{ label: 'Output Formats', slug: 'serialization/output-formats' },
								{ label: 'Multi-Stack Output', slug: 'serialization/multi-stack' },
							],
						},
						{
							label: 'Components',
							items: [
								{ label: 'Component Contract', slug: 'components/component-contract' },
								{ label: 'Capabilities', slug: 'components/capabilities' },
								{ label: 'Composition & Wiring', slug: 'components/composition-and-wiring' },
								{ label: 'Build Archive', slug: 'components/build-archive' },
								{ label: 'Attestation Reference', slug: 'components/attestation-reference' },
								{ label: 'Execution Backends', slug: 'components/backends-reference' },
								{ label: 'Observability', slug: 'components/observability' },
							],
						},
						{
							label: 'Lexicons',
							items: [
								{ label: 'AWS CloudFormation', link: '/lexicons/aws/' },
								{ label: 'Azure ARM', link: '/lexicons/azure/' },
								{ label: 'GCP Config Connector', link: '/lexicons/gcp/' },
								{ label: 'Fly Machines', link: '/lexicons/fly/' },
								{ label: 'Fountain', link: '/lexicons/fountain/' },
								{
									label: 'Kubernetes',
									items: [
										{ label: 'Overview', link: '/lexicons/k8s/' },
										{ label: 'Generic Composites', link: '/lexicons/k8s/composite-examples/' },
										{ label: 'EKS Composites', link: '/lexicons/k8s/eks-composites/' },
										{ label: 'AKS Composites', link: '/lexicons/k8s/aks-composites/' },
										{ label: 'GKE Composites', link: '/lexicons/k8s/gke-composites/' },
									],
								},
								{ label: 'Helm Charts', link: '/lexicons/helm/' },
								{ label: 'GitHub Actions', link: '/lexicons/github/' },
								{ label: 'GitLab CI/CD', link: '/lexicons/gitlab/' },
								{ label: 'Forgejo Actions', link: '/lexicons/forgejo/' },
								{ label: 'Docker', link: '/lexicons/docker/' },
								{ label: 'Temporal', link: '/lexicons/temporal/' },
							],
						},
						{
							label: 'Lexicon authoring',
							collapsed: true,
							badge: { text: 'Plugin Dev', variant: 'tip' },
							items: [
								{ label: 'Completeness Checklist', slug: 'lexicon-authoring/completeness-checklist' },
								{ label: 'Skills', slug: 'lexicon-authoring/skills' },
								{ label: 'Observation Contract', slug: 'lexicon-authoring/observation-contract' },
								{ label: 'Apply Conformance Suite', slug: 'lexicon-authoring/applying-conformance' },
							],
						},
					],
				},
				{
					label: 'Explanation',
					items: [
						{
							label: 'Concepts',
							items: [
								{ label: 'Introduction', slug: 'getting-started/introduction' },
								{ label: 'What chant is', slug: 'concepts/overview' },
								{ label: 'Philosophy', slug: 'concepts/philosophy' },
								{ label: 'How chant compares', slug: 'concepts/comparison' },
								{ label: 'Lifecycle Models', slug: 'concepts/lifecycle-models' },
								{ label: 'Choosing Your Deployment Model', slug: 'concepts/deployment-paths' },
								{ label: 'Components', slug: 'concepts/components' },
								{ label: 'TypeScript as Data', slug: 'concepts/typescript-as-data' },
								{ label: 'Build-Time Parameters', slug: 'concepts/build-time-parameters' },
								{ label: 'Where Values Come From', slug: 'concepts/where-values-come-from' },
								{ label: 'Evaluation Pipeline', slug: 'concepts/evaluation-pipeline' },
								{ label: 'State and Governance', slug: 'concepts/governance' },
								{ label: 'Drift Detection', slug: 'concepts/drift-detection' },
								{ label: 'Reconciliation', slug: 'concepts/reconciliation' },
								{ label: 'Effect Receipts', slug: 'concepts/effect-receipts' },
								{ label: 'Plan Scenarios', slug: 'concepts/plan-scenarios' },
								{ label: 'Durable Workflows', slug: 'concepts/durable-workflows' },
								{ label: 'Local vs Temporal', slug: 'guide/local-vs-temporal' },
								{ label: 'Agent Integration', slug: 'guide/agent-integration' },
							],
						},
						{
							label: 'Components',
							items: [
								{ label: 'Overview', slug: 'components/overview' },
								{ label: 'Supply-Chain Attestations', slug: 'components/supply-chain' },
								{ label: 'Orchestration', slug: 'components/orchestration' },
								{ label: 'Cloud-Agnostic Boundary', slug: 'components/cloud-boundary' },
							],
						},
						{ label: 'Lexicons', slug: 'lexicons/overview' },
						{
							label: 'Lexicon authoring',
							collapsed: true,
							badge: { text: 'Plugin Dev', variant: 'tip' },
							items: [
								{ label: 'Lexicon Authoring Overview', slug: 'lexicon-authoring/overview' },
								{ label: 'Implementing Apply', slug: 'lexicon-authoring/applying' },
							],
						},
						{ label: 'Examples — Tiers and Layout', slug: 'contributing/examples' },
						{
							label: 'Architecture',
							collapsed: true,
							badge: { text: 'Core Dev', variant: 'note' },
							items: [
								{ label: 'Architecture Overview', slug: 'architecture/overview' },
								{ label: 'Core Type System', slug: 'architecture/core-type-system' },
								{ label: 'File Discovery', slug: 'architecture/discovery' },
								{ label: 'Evaluator Engine', slug: 'architecture/evaluator' },
								{ label: 'Sandboxed Execution', slug: 'architecture/sandbox' },
								{ label: 'Module Graph', slug: 'architecture/module-graph' },
								{ label: 'Lexicon Registry', slug: 'architecture/lexicon-registry' },
								{ label: 'Serializer', slug: 'architecture/serializer' },
							],
						},
					],
				},
				{ label: "What's New", slug: 'whats-new' },
			],
		}),
	],
});
