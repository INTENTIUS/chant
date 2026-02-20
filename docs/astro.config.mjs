// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://intentius.io',
	base: '/chant',
	integrations: [
		starlight({
			title: 'chant',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/intentius/chant' }],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
						{ label: 'Parameters & Outputs', slug: 'getting-started/parameters-and-outputs' },
						{ label: 'Project Structure', slug: 'getting-started/project-structure' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
					],
				},
				{
					label: 'Core Concepts',
					items: [
						{ label: 'Philosophy', slug: 'concepts/philosophy' },
						{ label: 'TypeScript as Data', slug: 'concepts/typescript-as-data' },
						{ label: 'Evaluation Pipeline', slug: 'concepts/evaluation-pipeline' },
						{ label: 'Barrel Files & $', slug: 'concepts/barrels' },
					],
				},
				{
					label: 'User Guide',
					items: [
						{ label: 'Writing Resources', slug: 'guide/writing-resources' },
						{ label: 'Using Barrel Files', slug: 'guide/barrel-files' },
						{ label: 'Cross-File References', slug: 'guide/cross-file-references' },
						{ label: 'Composite Resources', slug: 'guide/composite-resources' },
						{ label: 'Presets', slug: 'guide/presets' },
						{ label: 'Linting & Type-Checking', slug: 'guide/linting' },
						{ label: 'Building', slug: 'guide/building' },
						{ label: 'Importing Templates', slug: 'guide/importing-templates' },
						{ label: 'Multi-Stack Projects', slug: 'guide/multi-stack' },
						{ label: 'Managing Lexicons', slug: 'guide/managing-lexicons' },
						{ label: 'Cross-Lexicon Projects', slug: 'guide/cross-lexicon' },
					{ label: 'Agent Integration', slug: 'guide/agent-integration' },
					],
				},
				{
					label: 'Lexicons',
					items: [
						{ label: 'Overview', slug: 'lexicons/overview' },
						{ label: 'AWS CloudFormation', link: '/lexicons/aws/' },
						{ label: 'GitLab CI/CD', link: '/lexicons/gitlab/' },
						{ label: 'Sync Mechanism', slug: 'lexicons/sync' },
					],
				},
				{
					label: 'CLI Reference',
					items: [
						{ label: 'Overview', slug: 'cli/overview' },
						{ label: 'init', slug: 'cli/init' },
						{ label: 'build', slug: 'cli/build' },
						{ label: 'lint', slug: 'cli/lint' },
						{ label: 'list', slug: 'cli/list' },
						{ label: 'import', slug: 'cli/import' },
						{ label: 'update', slug: 'cli/update' },
						{ label: 'doctor', slug: 'cli/doctor' },
						{ label: 'serve lsp', slug: 'cli/lsp' },
						{ label: 'serve mcp', slug: 'cli/mcp' },
					],
				},
				{
					label: 'Lint Rules',
					items: [
						{ label: 'Overview', slug: 'lint-rules/overview' },
						{ label: 'Evaluability (EVL)', slug: 'lint-rules/evaluability' },
						{ label: 'Style', slug: 'lint-rules/style' },
						{ label: 'Cross-File', slug: 'lint-rules/cross-file' },
						{ label: 'Correctness', slug: 'lint-rules/correctness' },
						{ label: 'Composite', slug: 'lint-rules/composite' },
						{ label: 'Custom Rules', slug: 'lint-rules/custom-rules' },
						{ label: 'Configuration', slug: 'lint-rules/configuration' },
						{ label: 'Disable Directives', slug: 'lint-rules/disable-directives' },
						{ label: 'Auto-Fix', slug: 'lint-rules/auto-fix' },
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
					label: 'Configuration',
					items: [
						{ label: 'Config File', slug: 'configuration/config-file' },
						{ label: 'TypeScript Configuration', slug: 'configuration/tsconfig' },
						{ label: 'Watch Mode', slug: 'configuration/watch' },
					],
				},
				{
					label: 'Lexicon Authoring',
					collapsed: true,
					badge: { text: 'Plugin Dev', variant: 'tip' },
					items: [
						{ label: 'Overview', slug: 'lexicon-authoring/overview' },
						{ label: 'Scaffold a Lexicon', slug: 'lexicon-authoring/scaffold' },
						{ label: 'Implement Generate', slug: 'lexicon-authoring/generate' },
						{ label: 'Create a Serializer', slug: 'lexicon-authoring/serializer' },
						{ label: 'Write Lint Rules', slug: 'lexicon-authoring/lint-rules' },
						{ label: 'LSP & MCP Providers', slug: 'lexicon-authoring/lsp-mcp' },
						{ label: 'Skills', slug: 'lexicon-authoring/skills' },
						{ label: 'Package & Publish', slug: 'lexicon-authoring/package' },
						{
							label: 'CLI Reference',
							items: [
								{ label: 'init lexicon', slug: 'cli/init-lexicon' },
								{ label: 'dev generate', slug: 'cli/generate' },
								{ label: 'dev publish', slug: 'cli/package' },
								{ label: 'dev rollback', slug: 'cli/rollback' },
							],
						},
					],
				},
				{
					label: 'Contributing',
					collapsed: true,
					badge: { text: 'Core Dev', variant: 'note' },
					items: [
						{ label: 'Development Setup', slug: 'contributing/development' },
						{ label: 'Architecture Overview', slug: 'architecture/overview' },
						{ label: 'Core Type System', slug: 'architecture/core-type-system' },
						{ label: 'File Discovery', slug: 'architecture/discovery' },
						{ label: 'Evaluator Engine', slug: 'architecture/evaluator' },
						{ label: 'Module Graph', slug: 'architecture/module-graph' },
						{ label: 'Lexicon Registry', slug: 'architecture/lexicon-registry' },
						{ label: 'Serializer', slug: 'architecture/serializer' },
					],
				},
				{
					label: 'Troubleshooting',
					collapsed: true,
					items: [
						{ label: 'Common Errors', slug: 'troubleshooting/common-errors' },
						{ label: 'Lexicon Issues', slug: 'troubleshooting/lexicon-issues' },
						{ label: 'Type Errors', slug: 'troubleshooting/type-errors' },
					],
				},
			],
		}),
	],
});
