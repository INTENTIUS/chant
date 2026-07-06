# adopt-alb-services — turning bespoke pipelines into build.json

Two services behind one shared ALB. This example exists to be adopted: it starts
from the pipeline a team already has — a hand-rolled CI job per service — and
shows the same release as a set of `build.json` components a single generic
driver runs. Nothing about the infrastructure changes. What changes is that the
pipeline stops being bespoke.

If your setup is "every service has its own build-and-deploy script, and they're
all slight variations of each other," this is the before-and-after for you.

## The before

[`before/.gitlab-ci.yml`](before/.gitlab-ci.yml) is the starting point: `api` and
`ui`, each with a `build-*` job (docker build + push) and a `deploy-*` job. Look
at what the deploy job has to do before it can deploy:

```yaml
- OUTPUTS=$(aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].Outputs' --output json)
- PARAMS=$(echo "$OUTPUTS" | jq -r '[(.[] | select(.OutputKey == "ClusterArn") | ...), ...] | join(" ")')
- IMAGE_URI=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "ApiRepoUri") | .OutputValue'):${CI_COMMIT_REF_SLUG}
- aws cloudformation deploy --template-file templates/api.json --parameter-overrides $PARAMS image=$IMAGE_URI
```

It reaches into another stack, pulls its outputs, and greps out the handful it
needs. That block is written once per service. The `ui` jobs are a near-verbatim
copy of the `api` jobs. Add a third service and you copy it a third time. Change
how deploys work — add a wait, change a flag — and you edit every copy.

## The after

The same release is three declarations:

| File | What it is |
|---|---|
| [`shared-alb.component.ts`](shared-alb.component.ts) | the shared VPC/ALB/cluster/ECR stack — `infra` archetype, one `cfn-deploy` |
| [`api.component.ts`](api.component.ts) | build → publish → apply → verify for `api` |
| [`ui.component.ts`](ui.component.ts) | the same, for `ui` |

No pipeline file. A single generic driver reads the three declarations and runs
them. It derives the order from `dependsOn`:

```
$ chant graph --components
Deploy order (waves apply top-to-bottom; a wave's components are parallel-safe):
  1. shared-alb
  2. api, ui
Dependencies (consumer → producer):
  api → shared-alb
  ui → shared-alb
```

### Each bespoke step maps to a capability

The pipeline's shell steps are named capabilities the driver dispatches to:

| Bespoke shell | Capability |
|---|---|
| `docker build` / `docker push` | `docker-build` (into the build archive) then `publish-image` (promote by digest) |
| `describe-stacks \| jq 'select(.OutputKey==...)'` | `stackOutput("shared-alb", "...")` — the driver resolves it |
| `aws cloudformation deploy --parameter-overrides ...` | `cfn-deploy` with typed `inputs` |
| *(nothing — the pipeline fires and forgets)* | `wait-steady-state` — waits for the rollout |

### The glue that disappears

The `describe-stacks | jq` block becomes the `inputs` on the apply step:

```ts
// api.component.ts
const fromSharedAlb = {
  clusterArn: stackOutput("shared-alb", "ClusterArn"),
  listenerArn: stackOutput("shared-alb", "ListenerArn"),
  albSgId: stackOutput("shared-alb", "AlbSgId"),
  // ...
};
// ...
{ kind: "cfn-deploy", stack: "api", template: "dist/api.template.json",
  inputs: { ...fromSharedAlb, image: "@Publish.uri" } }
```

`stackOutput("shared-alb", "ListenerArn")` names an output; the driver reads it
from the deployed shared-alb stack. `"@Publish.uri"` names the image the
`publish-image` step just promoted. No shell reaches into another stack, and the
image is passed by digest — the exact bytes built are the bytes deployed.

`fromSharedAlb` is identical in `api.component.ts` and `ui.component.ts`. It's
shared, not copied into a pipeline per service.

## Run it

### Against a local AWS emulator (Floci) — no account

[Floci](https://floci.io) is a free AWS emulator; `cfn-deploy` honors
`AWS_ENDPOINT_URL`, so pointing at it is one env var. Use **≥ 1.5.30** and mount
the docker socket — Floci starts a real backing container for the ECR registry,
so it needs docker access or the ECR repos fail to create and the shared-alb
stack rolls back.

```bash
docker run -d --rm -p 4566:4566 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name floci floci/floci:1.5.30
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

npm install
npm run build     # aws lexicon → dist/{shared-alb,api,ui}.template.json
npm run deploy    # chant run --components all --env local
```

`npm run deploy` runs `chant run --components all`: shared-alb applies first,
then api and ui in parallel. The same driver, no per-service code. shared-alb's
outputs (cluster, listener, repo URIs) resolve into each service by name, and
each service's ECS task lands in the shared cluster.

> **macOS note.** api and ui run in the same wave, so they `docker login` to the
> registry concurrently. Docker Desktop's `osxkeychain` credential helper can't
> service two logins to one registry at once and errors with `item already
> exists in the keychain`. This is a local macOS/Docker-Desktop artifact, not a
> chant or CI issue — Linux runners use a different credential store and don't
> race. If you hit it locally, deploy the services one at a time
> (`chant run --components shared-alb`, then each service), or run on Linux.

### Against real AWS

Drop the endpoint and use real credentials; nothing else changes.

```bash
unset AWS_ENDPOINT_URL
npm run build && npm run deploy
npm run teardown   # deletes the api, ui, and shared-alb stacks
```

## The point

Adding a service is adding one `build.json`, not one pipeline. The dozen verbs
underneath (`docker-build`, `publish-image`, `cfn-deploy`, `wait-steady-state`,
…) are written once and shared. A cross-cutting change is one capability edit,
not an edit to every service's copy of the same glue.

Compare the two files side by side:

```bash
diff before/.gitlab-ci.yml <(echo "see api.component.ts + ui.component.ts")
```

Read next: [Components Overview](https://intentius.io/chant/components/overview/),
[Composition & Wiring](https://intentius.io/chant/components/composition-and-wiring/).
