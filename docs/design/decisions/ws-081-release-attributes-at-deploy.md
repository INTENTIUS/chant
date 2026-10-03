---
schema: 1
id: "ws-081"
title: "Release attributes at deploy"
state: "decided"
area: "D22"
source:
  issue: "INTENTIUS/chant#3061"
  row: "Release step sets service.version and vcs.ref.head.revision on deployed workloads"
  revision: null
question: "ws-060 leaves `service.version` (the release's digest) and `vcs.ref.head.revision` (its commit) to the step that deploys the release, because stamping them at build time changes every generated file on every commit. How does that step get them onto a workload's resource attributes on each platform, without changing the committed generated files?"
options:
  - id: "a"
    label: "a static reference in the generated output, filled by the deploy"
    how: "A stamped workload's `OTEL_RESOURCE_ATTRIBUTES` ends with a reference to one variable, `CHANT_RELEASE_ATTRIBUTES`, written where the platform expands it: `${CHANT_RELEASE_ATTRIBUTES:-}` in a Compose file, which Compose interpolates from the environment of `docker compose up`, and `$(CHANT_RELEASE_ATTRIBUTES)` in a Kubernetes container, after an env entry that reads the pod annotation `chant.intentius.io/release-attributes` through the downward API. The value is a suffix, `,service.version=<digest>,vcs.ref.head.revision=<sha>`, percent-encoded like the rest. `chant run --components` (and promote, rollback and fan-out) puts the release on `DeployContext.release`: the commit from the caller, and the digest the component's publish step promoted, or the recorded digest a promote deploys. The `shell` and `remote-exec` steps export the variable before the command, and `kubectl-apply` sets the annotation on the pod template of each stamped workload in what it applies."
    tradeoff: "The generated files are the same bytes before and after any release; they change once, when the reference is added. Without a release the reference expands to nothing, so a plain `docker compose up` or `kubectl apply` of the same files still works. The value reaches the workload only through a step that knows the release: a hand-run deploy carries no version. On Kubernetes a release changes the pod template, which rolls the pods, as a new image would."
  - id: "b"
    label: "the deploy rewrites the workload's environment"
    how: "The deploy step edits `OTEL_RESOURCE_ATTRIBUTES` in what it applies: a Compose override file with the full value, or the container env in the Kubernetes documents."
    tradeoff: "No reference in the generated output. The deploy has to parse and merge each workload's attribute list, a Compose deploy needs an extra file on the host, and on Kubernetes a later apply of the committed manifest reverts the value and rolls the pods."
  - id: "c"
    label: "patch the live workload after the deploy"
    how: "After the apply, `kubectl set env` or a `docker compose` recreate with extra variables."
    tradeoff: "Two writes per deploy, a second rollout on Kubernetes, and the live workload no longer matches what was applied, which drift reads as a change."
choice:
  option: "a"
  reason: "The build keeps writing the whole attribute list, and the release adds only what it knows, through the expansion each platform already does. One variable name and one value format serve every platform, so a deploy step needs no knowledge of how a workload was stamped: it exports one variable or sets one annotation. The annotation is in what `kubectl-apply` applies, so a later apply of the same release keeps it, and the committed manifest is untouched."
rejected:
  - option: "b"
    why: "It moves the merge of each workload's attributes into every deploy step, and on Kubernetes the committed manifest and the live object disagree on the env itself."
  - option: "c"
    why: "Two writes per deploy, and the live workload drifts from what was applied."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3061"
    url: "https://github.com/INTENTIUS/chant/issues/3061"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-060, Telemetry attribution"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-060-telemetry-attribution.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "Kubernetes fieldpath: a missing annotation subscript reads as an empty string (pkg/fieldpath/fieldpath.go:68, v1.34.0)"
    url: "https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/fieldpath/fieldpath.go"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3061"
  - "INTENTIUS/chant#3060"
---

# Release attributes at deploy

ws-060 has the build stamp what it knows and leaves `service.version` and `vcs.ref.head.revision` to the step that deploys the release. This record says how that step gets them to the workload.

## The variable

`CHANT_RELEASE_ATTRIBUTES` holds the release's attributes as a suffix for `OTEL_RESOURCE_ATTRIBUTES`: `,service.version=<digest>,vcs.ref.head.revision=<sha>`, each value percent-encoded. It is empty when the deploy knows neither. The build-time list always has `chant.decl`, so the suffix never starts the list.

## Per platform

| Platform | In the generated output | Set by |
|---|---|---|
| Docker Compose | `OTEL_RESOURCE_ATTRIBUTES` ends with `${CHANT_RELEASE_ATTRIBUTES:-}` | the environment of `docker compose up`: `shell` passes it with `env`, `remote-exec` exports it on the host |
| Kubernetes | an env entry `CHANT_RELEASE_ATTRIBUTES` from `fieldRef: metadata.annotations['chant.intentius.io/release-attributes']`, before `OTEL_RESOURCE_ATTRIBUTES`, which ends with `$(CHANT_RELEASE_ATTRIBUTES)` | `kubectl-apply`, which sets the annotation on the pod template (or the Pod) of each workload whose containers read it, in what it applies |
| Fly | not yet | follows #3060, which stamps fly apps |

A Kubernetes `$(VAR)` reference expands only to a variable defined earlier in the container's list, so the entry goes just before `OTEL_RESOURCE_ATTRIBUTES`. A container that defines `CHANT_RELEASE_ATTRIBUTES` itself keeps its own. An `env` given as a map has no order, so it gets no reference.

## Where the release comes from

`DeployContext.release` carries it to every step.

- `chant run --components` and `chant components fan-out` set the commit to `git rev-parse HEAD`, or nothing outside a checkout.
- The driver sets the version to the digest of the last artifact the component's run promoted (a publish-family output with a `uri`), which is the digest auto-release records. A promote or rollback deploys a recorded digest without publishing, so that digest and the earlier release's commit are used.
- Each component has its own: one component's digest never stamps another's deploy.

## What does not change

The committed generated files are the same bytes before and after any release. A deploy without a release (a hand-run `docker compose up` or `kubectl apply`, or an Op) leaves the reference empty.
