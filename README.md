# chant

Infrastructure in TypeScript, out as CloudFormation, Kubernetes YAML, GitHub Actions and more.

**Working with an agent?** Paste this setup prompt into it. It stops at a pull request; [intentius.io/chant/agents](https://intentius.io/chant/agents/) has the steps it follows:

```text
Set up chant in this repository.
Read https://intentius.io/chant/llms.txt first, then
https://intentius.io/chant/agents/ and follow it.
Stop when `npx chant build` and `npx chant lint` pass, and open a pull request with the result.
Never deploy to a real cloud account or shared environment (with `chant run`, `chant components` or a platform's own CLI), approve (a pull request review, `chant approve` or `chant run approve`), override a policy denial (`chant approve policy-override`), or merge; never cut or publish a release (`chant release cut --yes` or `chant release publish`), push or delete a `ci/*` tag (`chant ci tick` pushes them), or change the value of an existing flag; never touch `.chant/allowed_signers` or `chant/lifecycle`.
```

The build is pure and runs locally. chant keeps no authoritative state file: it computes a precise change set against the live system from ownership markers on the cloud side, so you get a plan without hosting state. When an apply needs approval gates or rollback, declare its phases in an `*.op.ts` file. `chant run <op>` executes those phases in this process; a gate is a fact on the gate ledger, so a run that reaches an unapproved one records the pending fact and exits 3, `chant approve <op> <gate>` writes the resolution, and the next run walks through. `chant run <op> --on fountain` hands the same declaration to a steward when it needs a machine of its own. See [Ops as teammates](https://intentius.io/chant/concepts/durable-workflows/).

**[Read the docs](https://intentius.io/chant/getting-started/introduction/)**

> chant is in active development. Packages are published under the [`@intentius`](https://www.npmjs.com/org/intentius) org on npm.

## What It Looks Like

The [Quick Start](https://intentius.io/chant/getting-started/quick-start/) walks through a project.

## Audit any repo's CI/CD

Point [`chant audit`](https://intentius.io/chant/cli/audit/) at any repo, with or without a chant project, for a tiered CI security report (GitHub, GitLab, Forgejo/Codeberg):

```bash
chant audit https://github.com/owner/repo -f markdown -o report.md
```

It separates PR-worthy security findings (with ready-to-apply fix diffs) from hygiene.

## Packages

| Package | Description |
|---------|-------------|
| [@intentius/chant](packages/core) | Type system, discovery, build pipeline, semantic lint engine, CLI |
| [@intentius/chant-lexicon-aws](lexicons/aws) | AWS lexicon — S3, Lambda, IAM types + semantic lint rules |
| [@intentius/chant-lexicon-azure](lexicons/azure) | Azure lexicon — ARM resource types, template functions |
| [@intentius/chant-lexicon-gcp](lexicons/gcp) | GCP lexicon — Config Connector resource types, applied by `kubectl` or by chant's REST applier |
| [@intentius/chant-lexicon-gitlab](lexicons/gitlab) | GitLab CI lexicon — pipelines, jobs, variables |
| [@intentius/chant-lexicon-grafana](lexicons/grafana) | Grafana lexicon — dashboards, panels, typed PromQL/TraceQL/LogQL queries and datasources, emitted as dashboard JSON and provisioning files |
| [@intentius/chant-lexicon-helm](lexicons/helm) | Helm lexicon — charts, releases, values |
| [@intentius/chant-lexicon-k8s](lexicons/k8s) | Kubernetes lexicon — Deployments, Services, ConfigMaps + YAML import |
| [@intentius/chant-lexicon-otel](lexicons/otel) | OpenTelemetry Collector lexicon — typed receivers, processors, exporters, connectors and pipelines, emitted as collector YAML |
| [@intentius/chant-lexicon-prometheus](lexicons/prometheus) | Prometheus lexicon — typed recording and alerting rule groups and Alertmanager routing, emitted as a rule file and alertmanager.yml |
| [@intentius/chant-lexicon-sql](lexicons/sql) | SQL lexicon — database schema as typed declarations, one dialect at a time; ClickHouse first, with types from a pinned server's catalog (in progress, unpublished) |
| [@intentius/chant-lexicon-e2b](lexicons/e2b) | e2b lexicon — `chant run <op> --on e2b` runs an Op on a steward sandbox on E2B, or any API that speaks E2B's, that sleeps paused between runs; `Template` declares the image it is made from |
| [@intentius/chant-lexicon-render](lexicons/render) | Render lexicon — services, datastores, env groups, projects; applied straight to the Public API |