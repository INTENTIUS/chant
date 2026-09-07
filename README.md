# chant

A type system for operations.

**Working with an agent?** Paste this and it'll get to a working `chant build` on its own — full version at [intentius.io/chant/agents](https://intentius.io/chant/agents/):

```text
Install a chant lexicon for this project's target platform (aws, azure, gcp,
k8s, helm, docker, github, gitlab, forgejo, fly, terraform, or fountain) —
this also installs the chant CLI:

  npm install --save-dev @intentius/chant-lexicon-<name>

Then scaffold (use `.` if this repo is already the project root):

  npx chant init . --lexicon <name>

Read every skills/*/SKILL.md it writes before authoring anything — that's
the operational playbook for this platform. Author resources as typed
TypeScript exports, then validate with `npx chant build` and
`npx chant lint`. Query the estate with `npx chant search "<query>"`
instead of reading a raw synthesized dump.
```

Synthesis is pure and local. There is no authoritative state file — chant computes a precise change set against the live system using cloud-side ownership markers, so you get a plan without hosting state. When an apply needs approval gates or rollback, you declare the orchestration in an `*.op.ts` file. `chant run <op>` executes those phases in this process; a gate is a fact on the gate ledger, so a run that reaches an unapproved one records the pending fact and exits 3, `chant approve <op> <gate>` writes the resolution, and the next run walks through. `chant run <op> --on fountain` hands the same declaration to a steward when it needs a machine of its own. See [Ops as teammates](https://intentius.io/chant/concepts/durable-workflows/).

**[Read the docs →](https://intentius.io/chant/getting-started/introduction/)**

> chant is in active development. Packages are published under the [`@intentius`](https://www.npmjs.com/org/intentius) org on npm.

## What It Looks Like

Declare infrastructure as typed TypeScript — see the [Quick Start](https://intentius.io/chant/getting-started/quick-start/) for a walkthrough.

## Audit any repo's CI/CD

No project required — point [`chant audit`](https://intentius.io/chant/cli/audit/) at a repo and get a tiered CI security report (GitHub, GitLab, Forgejo/Codeberg):

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
| [@intentius/chant-lexicon-gcp](lexicons/gcp) | GCP lexicon — Deployment Manager resource types |
| [@intentius/chant-lexicon-gitlab](lexicons/gitlab) | GitLab CI lexicon — pipelines, jobs, variables |
| [@intentius/chant-lexicon-helm](lexicons/helm) | Helm lexicon — charts, releases, values |
| [@intentius/chant-lexicon-k8s](lexicons/k8s) | Kubernetes lexicon — Deployments, Services, ConfigMaps + YAML import |
| [@intentius/chant-lexicon-render](lexicons/render) | Render lexicon — services, datastores, env groups, projects; applied straight to the Public API |