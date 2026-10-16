// The link tables on the home page (components/LinkRows.astro), kept out of
// index.mdx so its prose stays prose. Each href is a path under the site's base.

export const LEXICONS = [
	{ label: 'Clouds', links: [
		{ label: 'AWS CloudFormation', href: '/lexicons/aws/' },
		{ label: 'Azure ARM', href: '/lexicons/azure/' },
		{ label: 'GCP Config Connector', href: '/lexicons/gcp/' },
		{ label: 'Fly Machines', href: '/lexicons/fly/' },
		{ label: 'Render', href: '/lexicons/render/' },
		{ label: 'Control Plane', href: '/lexicons/cpln/' },
	] },
	{ label: 'Kubernetes', links: [
		{ label: 'Kubernetes', href: '/lexicons/k8s/' },
		{ label: 'Helm', href: '/lexicons/helm/' },
		{ label: 'k3d', href: '/lexicons/k3d/' },
		{ label: 'k3s', href: '/lexicons/k3s/' },
	] },
	{ label: 'CI', links: [
		{ label: 'GitHub Actions', href: '/lexicons/github/' },
		{ label: 'GitLab CI/CD', href: '/lexicons/gitlab/' },
		{ label: 'Forgejo Actions', href: '/lexicons/forgejo/' },
	] },
	{ label: 'Observability', links: [
		{ label: 'OpenTelemetry Collector', href: '/lexicons/otel/' },
		{ label: 'Prometheus', href: '/lexicons/prometheus/' },
		{ label: 'Grafana', href: '/lexicons/grafana/' },
	] },
	{ label: 'Also', links: [
		{ label: 'Docker', href: '/lexicons/docker/' },
		{ label: 'Terraform', href: '/lexicons/terraform/' },
		{ label: 'SQL', href: '/lexicons/sql/' },
		{ label: 'Cedar', href: '/lexicons/cedar/' },
		{ label: 'Fountain', href: '/lexicons/fountain/' },
	] },
];

export const NEXT = [
	{ label: 'Start', links: [
		{ label: 'Introduction', href: '/getting-started/introduction/' },
		{ label: 'Quick Start', href: '/getting-started/quick-start/' },
		{ label: 'Agents Start Here', href: '/agents/' },
	] },
	{ label: 'Learn', links: [
		{ label: 'What chant is', href: '/concepts/overview/' },
		{ label: 'How chant compares', href: '/concepts/comparison/' },
		{ label: 'Choosing Your Deployment Model', href: '/concepts/deployment-paths/' },
	] },
	{ label: 'Look up', links: [
		{ label: 'CLI', href: '/cli/overview/' },
		{ label: 'Config File', href: '/configuration/config-file/' },
		{ label: 'Lint rules', href: '/lint-rules/overview/' },
	] },
	{ label: 'Changes', links: [
		{ label: "What's New", href: '/whats-new/' },
	] },
];
