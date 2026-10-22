// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeBaseUrl from '../packages/core/src/codegen/rehype-base-url.mjs';
import remarkAgentPrompt from './src/remark-agent-prompt.mjs';
import { lexiconGroups, lexiconPageBase } from './src/lexicon-sidebar.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://intentius.io',
	base: '/chant',
	markdown: {
		remarkPlugins: [remarkAgentPrompt],
		// A lexicon page's root-relative link means its own lexicon's root, as
		// it did when each lexicon had its own site (chant #3993).
		rehypePlugins: [[rehypeBaseUrl, { base: '/chant', projectBase: '/chant', baseFor: lexiconPageBase }]],
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
			description: 'Infrastructure in TypeScript, out as CloudFormation, Kubernetes YAML, GitHub Actions and more.',
			// The pixel face and the sound waves (scripts/brand/), Geist, and the
			// palette as tokens for both themes.
			customCss: ['./src/styles/chant.css'],
			// The title gets "Copy page as Markdown", the llms.txt pointer and the
			// page's agent prompt. The site title and footer carry the logo, the
			// header a Docs link, and the theme starts dark.
			components: {
				PageTitle: './src/components/PageTitle.astro',
				Footer: './src/components/Footer.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			// public/favicon.svg is the logo, drawn by scripts/brand/logo.py; the
			// PNG is the fallback for browsers without SVG favicons.
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/intentius/chant' }],
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/chant/favicon-48.png', sizes: '48x48', type: 'image/png' } },
				// The card a shared link shows (LinkedIn, Slack, X). It has to be an
				// absolute URL to a PNG or JPEG; LinkedIn ignores SVG. Drawn by
				// scripts/brand/logo.py --og.
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://intentius.io/chant/brand/og.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'The chant logo, a pixel face with sound waves, over the word CHANT' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://intentius.io/chant/brand/og.png' } },
				// PostHog's loader snippet, with one change: its `n<o.length` reads
				// `o.length>n`. lychee's HTML tokenizer took `<o.length...` for a tag
				// and stopped reading the page there, so the link check saw three
				// links per page and passed without checking the rest (chant #3993).
				{
					tag: 'script',
					content: `
						!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;o.length>n;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
						posthog.init('phc_uAQ5KE5uLZeSiPqbqnsUPRkeJZem5ht9vMVP3TgX7yqj', {
							api_host: 'https://us.i.posthog.com',
							defaults: '2026-05-30',
						})
					`,
				},
			],
			plugins: [
				// Ships /llms.txt and /llms-full.txt from the same content at build
				// time — chant #1220. No page for these; starlight-llms-txt injects
				// its own Astro routes and renders every Starlight doc to Markdown.
				starlightLlmsTxt({
					description:
						'chant is a TypeScript-first infrastructure tool: typed resources in, spec-native output (CloudFormation, GitLab CI, Kubernetes YAML, and more) out, validated by semantic lint rules, with an optional deployment lifecycle on top: Ops that run in-process or on a fountain steward.',
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
				// Every group starts collapsed; Starlight opens the one holding the
				// current page. "Start here" holds the room pages under /for/
				// (src/pages/for/[id].astro), which are not content pages, so it
				// sits outside the four quadrants. Its items are the tiles and roles of
				// src/data/rooms.mjs, written out because the Diátaxis check reads
				// this list as plain data; scripts/check-rooms.mjs fails the build
				// when the two disagree.
				{
					label: 'Start here',
					collapsed: true,
					items: [
						{ label: 'AWS', link: '/for/aws/' },
						{ label: 'Kubernetes', link: '/for/kubernetes/' },
						{ label: 'GCP and Azure', link: '/for/gcp-azure/' },
						{ label: 'CI pipelines', link: '/for/ci/' },
						{ label: 'Fly and containers', link: '/for/fly/' },
						{ label: 'I work with a coding agent', link: '/for/agents/' },
						{ label: 'I run a platform team', link: '/for/platform/' },
						{ label: 'I ship releases from trunk', link: '/for/releases/' },
						{ label: 'I review security', link: '/for/security/' },
						{ label: 'I am evaluating', link: '/for/evaluate/' },
					],
				},
				{
					label: 'Tutorials',
					collapsed: true,
					items: [
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
						{ label: 'From Zero to a Promoted Release', slug: 'tutorials/zero-to-promoted-release' },
						{ label: 'Alert Triage (local)', slug: 'tutorials/alert-triage-local' },
						{ label: 'Agent Observability on k3d', slug: 'tutorials/agent-observability' },
						{ label: 'Carve out of Terraform', slug: 'tutorials/terraform-carve-out' },
						{ label: 'Run Ops on a Fountain Steward', slug: 'tutorials/fountain-steward' },
						{
							label: 'Fly',
							collapsed: true,
							items: [
								{ label: 'Deploy Fly Machines Offline', slug: 'tutorials/local-fly' },
								{ label: 'Reconcile Fly Machines', slug: 'tutorials/fly-machines-reconcile' },
								{ label: 'Fly Deploy with Checkpoint Rollback', slug: 'tutorials/fly-deploy-rollback' },
								{ label: 'Durable Fly Deploy', slug: 'tutorials/fly-durable-deploy' },
								{ label: 'Managed Agents Worker on Sprites', slug: 'tutorials/sprites-managed-agent-worker' },
								{ label: 'Disposable Build Sandbox on Sprites', slug: 'tutorials/sprites-build-sandbox' },
							],
						},
						{ label: 'GCP GKE + Kubernetes', slug: 'tutorials/gke-kubernetes' },
						{ label: 'AWS EKS + Kubernetes', slug: 'tutorials/eks-kubernetes' },
						{ label: 'Azure AKS + Kubernetes', slug: 'tutorials/aks-kubernetes' },
						{ label: 'GitLab CI + AWS ALB', slug: 'tutorials/gitlab-aws-alb' },
						{ label: 'Per-PR Preview Environments', slug: 'tutorials/github-pr-preview' },
						{ label: 'CockroachDB Multi-Region', slug: 'tutorials/cockroachdb-multi-region' },
						{ label: 'GitLab Cells on GKE', slug: 'tutorials/gitlab-cells' },
						{ label: 'Ray + KubeRay on GKE', slug: 'tutorials/ray-kuberay-gke' },
						{ label: 'Argo CD on GKE', slug: 'tutorials/argo-cd-gke' },
						{ label: 'Flux CD Self-Hosted', slug: 'tutorials/flux-apps' },
					],
				},
				{
					label: 'How-to guides',
					collapsed: true,
					items: [
						{ label: 'Agents Start Here', slug: 'agents' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{
							label: 'Author resources',
							collapsed: true,
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
							collapsed: true,
							items: [
								{ label: 'Linting & Type-Checking', slug: 'guide/linting' },
								{ label: 'Organizational Policy', slug: 'guide/organizational-policy' },
								{ label: 'Custom Rules', slug: 'lint-rules/custom-rules' },
								{ label: 'Auto-Fix', slug: 'lint-rules/auto-fix' },
							],
						},
						{
							label: 'Build and run',
							collapsed: true,
							items: [
								{ label: 'Building', slug: 'guide/building' },
								{ label: 'Watch Mode', slug: 'configuration/watch' },
								{ label: 'Ops', slug: 'guide/ops' },
								{ label: 'Watching Lifecycle', slug: 'guide/watching-lifecycle' },
								{ label: 'Drift Back to Source', slug: 'guide/drift-to-source' },
								{ label: 'Checking Health', slug: 'guide/checking-health' },
								{ label: 'Reconciling Lifecycle', slug: 'guide/reconciling-lifecycle' },
								{ label: 'Converging Lifecycle', slug: 'guide/converging-lifecycle' },
								{ label: 'Operator', slug: 'guide/operator' },
								{ label: 'Pinned Module Rollout', slug: 'guide/pinned-module-rollout' },
								{ label: 'Op Waves', slug: 'guide/op-waves' },
								{ label: 'Notify', slug: 'guide/notify' },
								{ label: 'Approval Rules', slug: 'guide/approval-rules' },
							],
						},
						{
							label: 'Components',
							collapsed: true,
							items: [
								{ label: 'Wiring Components', slug: 'components/wiring-howto' },
								{ label: 'Generated CI for Pull Requests', slug: 'guide/pull-request-ci' },
								{ label: 'Apply on Merge (opt-in)', slug: 'guide/apply-on-merge' },
								{ label: 'Move off Apply on Merge', slug: 'guide/move-off-apply-on-merge' },
							],
						},
						{
							label: 'Trunk and releases',
							collapsed: true,
							items: [
								{ label: 'Set Up Trunk with Curated Releases', slug: 'guide/trunk-curated-setup' },
								{ label: 'Tag Green Commits', slug: 'guide/green-commits' },
								{ label: 'Curate a Release', slug: 'guide/curate-a-release' },
								{ label: 'Land Without a Pull Request', slug: 'guide/land-without-a-pull-request' },
								{ label: 'Compose a Release', slug: 'guide/compose-a-release' },
								{ label: 'Release from Your Workstation', slug: 'guide/release-from-workstation' },
								{ label: 'Promote a Release', slug: 'guide/promote-a-release' },
								{ label: 'Prune chant/lifecycle', slug: 'guide/prune-lifecycle' },
								{ label: 'Read Delivery Metrics', slug: 'guide/delivery-metrics' },
							],
						},
						{
							label: 'Security',
							collapsed: true,
							items: [
								{ label: 'Publish Only Verified Releases', slug: 'guide/security-verified-releases' },
								{ label: 'Require SBOMs and Provenance', slug: 'guide/security-supply-chain' },
								{ label: 'Sign What the Runners Do', slug: 'guide/security-who-ran-it' },
								{ label: 'Require Forge Review for Applies', slug: 'guide/security-review-rules' },
								{ label: 'Run Applies Only on Started Runners', slug: 'guide/security-isolated-runners' },
							],
						},
						{
							label: 'Workspaces',
							collapsed: true,
							items: [
								{ label: 'Asking How a File Got This Way', slug: 'guide/tracing-intent' },
								{ label: 'Work Items', slug: 'guide/work-items' },
								{ label: 'Feature Flags', slug: 'guide/feature-flags' },
								{ label: 'Decision Points', slug: 'guide/decision-points' },
								{ label: 'Recording Decisions by Hand', slug: 'guide/recording-decisions-by-hand' },
							],
						},
						{
							label: 'Local testing',
							collapsed: true,
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
							collapsed: true,
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
					collapsed: true,
					items: [
						{ label: 'Project Structure', slug: 'getting-started/project-structure' },
						{ label: 'Network Egress', slug: 'reference/network-egress' },
						{ label: 'Behaviour Coverage', slug: 'reference/behaviour-coverage' },
						{ label: 'Level-0 Exceptions', slug: 'reference/level-0-exceptions' },
						{ label: 'Publish Targets', slug: 'reference/publish-targets' },
						{ label: 'Security Features', slug: 'reference/security-features' },
						{ label: 'CI Workflows', slug: 'reference/ci-workflows' },
						{ label: 'Change-Set Document', slug: 'reference/change-set' },
						{ label: 'Lineage Lock', slug: 'reference/lineage-lock' },
						{ label: 'Template Migrations', slug: 'reference/template-migrations' },
						{ label: 'Workspace Declaration', slug: 'reference/workspace-declaration' },
						{ label: 'Workspace Kinds', slug: 'reference/workspace-kinds' },
						{ label: 'Workspace Read Contract', slug: 'reference/workspace-read-contract' },
						{ label: 'Workspace Writer Conformance', slug: 'reference/workspace-writer-conformance' },
						{ label: 'Broker Protocol', slug: 'reference/broker-protocol' },
						{ label: 'Decision Record Kind', slug: 'reference/decision-kind' },
						{ label: 'Decision Review Views', slug: 'reference/decision-review-views' },
						{ label: 'Owners of the Workspace Boundary', slug: 'reference/boundary' },
						{
							label: 'CLI',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'cli/overview' },
								{ label: 'init', slug: 'cli/init' },
								{ label: 'build', slug: 'cli/build' },
								{ label: 'lint', slug: 'cli/lint' },
								{ label: 'list', slug: 'cli/list' },
								{ label: 'describe', slug: 'cli/describe' },
								{ label: 'search', slug: 'cli/search' },
								{ label: 'vendor', slug: 'cli/vendor' },
								{ label: 'generate', slug: 'cli/codegen' },
								{ label: 'import', slug: 'cli/import' },
								{ label: 'carve advise', slug: 'cli/carve' },
								{ label: 'carve out (emit/bridge/apply)', slug: 'cli/carve-out' },
								{ label: 'change-set', slug: 'cli/change-set' },
								{ label: 'ci', slug: 'cli/ci' },
								{ label: 'release', slug: 'cli/release' },
								{ label: 'audit', slug: 'cli/audit' },
								{ label: 'migrate', slug: 'cli/migrate' },
								{ label: 'update', slug: 'cli/update' },
								{ label: 'doctor', slug: 'cli/doctor' },
								{ label: 'run', slug: 'cli/run' },
								{ label: 'operator', slug: 'cli/operator' },
								{ label: 'graph', slug: 'cli/graph' },
								{ label: 'workspace init', slug: 'cli/workspace-init' },
								{ label: 'workspace ls', slug: 'cli/workspace-ls' },
								{ label: 'workspace status', slug: 'cli/workspace-status' },
								{ label: 'workspace metrics', slug: 'cli/workspace-metrics' },
								{ label: 'workspace records', slug: 'cli/workspace-records' },
								{ label: 'workspace work', slug: 'cli/workspace-work' },
								{ label: 'workspace runs', slug: 'cli/workspace-runs' },
								{ label: 'workspace box', slug: 'cli/workspace-box' },
								{ label: 'workspace member and host', slug: 'cli/workspace-member' },
								{ label: 'workspace wip', slug: 'cli/workspace-wip' },
								{ label: 'workspace points', slug: 'cli/workspace-points' },
								{ label: 'workspace verify', slug: 'cli/workspace-verify' },
								{ label: 'workspace pin', slug: 'cli/workspace-pin' },
								{ label: 'workspace agent', slug: 'cli/workspace-agent' },
								{ label: 'workspace trust', slug: 'cli/workspace-trust' },
								{ label: 'workspace signers', slug: 'cli/workspace-signers' },
								{ label: 'workspace evidence', slug: 'cli/workspace-evidence' },
								{ label: 'workspace lineage', slug: 'cli/workspace-lineage' },
								{ label: 'workspace upgrade', slug: 'cli/workspace-upgrade' },
								{ label: 'workspace adopt-lineage', slug: 'cli/workspace-adopt-lineage' },
								{ label: 'workspace versions', slug: 'cli/workspace-versions' },
								{ label: 'workspace export', slug: 'cli/workspace-export' },
								{ label: 'workspace check', slug: 'cli/workspace-check' },
								{ label: 'workspace patch', slug: 'cli/workspace-patch' },
								{ label: 'workspace build', slug: 'cli/workspace-build' },
								{ label: 'workspace lint', slug: 'cli/workspace-lint' },
								{ label: 'workspace audit', slug: 'cli/workspace-audit' },
								{ label: 'workspace graph', slug: 'cli/workspace-graph' },
								{ label: 'lifecycle', slug: 'cli/lifecycle' },
								{ label: 'scenario', slug: 'cli/scenario' },
								{ label: 'components', slug: 'cli/components' },
								{ label: 'emulator', slug: 'cli/emulator' },
								{ label: 'serve lsp', slug: 'cli/lsp' },
								{ label: 'serve mcp', slug: 'cli/mcp' },
								{
									label: 'dev',
									collapsed: true,
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
							collapsed: true,
							items: [
								{ label: 'Config File', slug: 'configuration/config-file' },
								{ label: 'TypeScript Configuration', slug: 'configuration/tsconfig' },
							],
						},
						{
							label: 'Ops and lifecycle',
							collapsed: true,
							items: [
								{ label: 'Ops Reference', slug: 'guide/ops-reference' },
							],
						},
						{
							label: 'Lint rules',
							collapsed: true,
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
							collapsed: true,
							items: [
								{ label: 'Output Formats', slug: 'serialization/output-formats' },
								{ label: 'Multi-Stack Output', slug: 'serialization/multi-stack' },
							],
						},
						{
							label: 'Components',
							collapsed: true,
							items: [
								{ label: 'Component Contract', slug: 'components/component-contract' },
								{ label: 'Capabilities', slug: 'components/capabilities' },
								{ label: 'Plan Previews', slug: 'components/plan-previews' },
								{ label: 'Composition & Wiring', slug: 'components/composition-and-wiring' },
								{ label: 'Build Archive', slug: 'components/build-archive' },
								{ label: 'Attestation Reference', slug: 'components/attestation-reference' },
								{ label: 'Execution Backends', slug: 'components/backends-reference' },
								{ label: 'Observability', slug: 'components/observability' },
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
					collapsed: true,
					items: [
						{
							label: 'Concepts',
							collapsed: true,
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
								{ label: 'Trunk and Releases', slug: 'concepts/trunk-and-releases' },
								{ label: 'Where Values Come From', slug: 'concepts/where-values-come-from' },
								{ label: 'Evaluation Pipeline', slug: 'concepts/evaluation-pipeline' },
								{ label: 'State and Governance', slug: 'concepts/governance' },
								{ label: 'Drift Detection', slug: 'concepts/drift-detection' },
								{ label: 'Reconciliation', slug: 'concepts/reconciliation' },
								{ label: 'Effect Receipts', slug: 'concepts/effect-receipts' },
								{ label: 'Plan Scenarios', slug: 'concepts/plan-scenarios' },
								{ label: 'Ops as Teammates', slug: 'concepts/durable-workflows' },
								{ label: 'Agent Integration', slug: 'guide/agent-integration' },
							],
						},
						{
							label: 'Components',
							collapsed: true,
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
				// One collapsed group per lexicon, Diátaxis subgroups inside, read from
				// the _sidebar.json fragments the lexicon docs pipeline writes beside
				// each lexicon's pages (src/lexicon-sidebar.mjs, chant #3993).
				// scripts/check-docs-diataxis.mjs checks each page against the
				// subgroup it sits in.
				{ label: 'Lexicons', collapsed: true, items: lexiconGroups() },
				{ label: "What's New", slug: 'whats-new' },
			],
		}),
	],
});
