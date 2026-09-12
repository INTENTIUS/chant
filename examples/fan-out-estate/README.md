# fan-out-estate: one change, fifteen stacks, an order nobody wrote down

An estate shaped like the ones that actually hurt to deploy: one shared
`network` stack, two clusters that sit on it, and twelve apps split across the
two clusters. Fifteen CloudFormation stacks, each deployed on its own, each with
its own template and its own lifecycle.

```
                         network
                        /       \
                 cluster-a       cluster-b
                /  /  / \ \ \    /  /  / \ \ \
           app-01 ..... app-06  app-07 ..... app-12
```

Change something in `network` and fourteen stacks are downstream of it. Change
`cluster-a` and six are. Change `app-09` and nothing is. The interesting part is
that no file in this project says any of that. The order comes out of the
source.

## Where the edges live

Every edge is stated twice, in two places that have to agree, and neither of
them is a list of deploy steps.

The first statement is `dependsOn` on the component. `clusters.component.ts`
says `dependsOn: ["network"]`; `apps.component.ts` says `dependsOn:
["cluster-a"]` for the first six apps and `dependsOn: ["cluster-b"]` for the
rest. That is what `chant components fan-out` reads to order a run.

The second statement is the template wiring. `src/network/outputs.ts` publishes
`TopicArn` and `QueueUrl`. Each cluster declares those two as CloudFormation
parameters in its `params.ts`, tags its DynamoDB table with them in
`resources.ts`, and publishes a `TableName` of its own. Each app declares that
`TableName` as a parameter and builds its log group name out of it, so an app
template cannot be turned into a deployable stack without a value only its
cluster produces. The component fills each parameter with `stackOutput("<the
upstream stack>", "<the output name>")` in its `cfn-deploy` step's `inputs`.

That second statement is why the first one is trustworthy. A dependency registry
you maintain by hand drifts the moment somebody deletes a reference and forgets
the registry entry. Here the reference is what the stack is built out of: remove
it and the template changes, and the change shows up in the diff the fan-out
starts from.

## Layout

- `chant.config.ts` names the fifteen stacks and the source directory each is
  built from, plus a `local` environment pointing at an emulator endpoint.
- `src/<stack>/` is one build root per stack. A stack is a build root, so the
  twelve apps get twelve directories even though their components share a file.
- `network.component.ts`, `clusters.component.ts`, `apps.component.ts` hold the
  fifteen components. chant discovers every exported `Component` from a
  `*.component.ts`, so the twelve apps live in one file where the split between
  the two clusters is visible at a glance.
- `dist/<stack>.template.json` is what `npm run build` synthesizes, and is
  exactly what `cfn-deploy` applies.

Each stack is small and free-tier: an SNS topic and an SQS queue in `network`, a
DynamoDB table and a CloudWatch log group in each cluster, a log group and a
queue in each app. Nothing needs a VPC, and every type here is one the emulator
provisions for real.

## Run it against a local AWS emulator

[Floci](https://floci.io) is a fast, free AWS emulator. `cfn-deploy` honors
`AWS_ENDPOINT_URL`, so pointing chant at it takes one environment variable.

```bash
docker run -d --rm -p 4566:4566 --name floci floci/floci:latest

export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

npm install
npm run build      # synthesize all fifteen templates into dist/
npm run lint       # semantic lint over every stack directory
```

Then fan a change out across the estate:

```bash
npm run plan       # chant components fan-out --base HEAD~1 --dry-run
npm run deploy     # the same derivation, dispatched, against --env local
```

`HEAD~1` in those scripts is a stand-in. The base ref is the argument: it is
whatever you are comparing against, usually the branch point or the last
deployed commit, and `chant components fan-out --base <ref>` takes it directly.
A CI job that has already run `chant lifecycle affected --base <ref> --json` can
hand the result over instead, with `--from-affected <file>`, rather than
building both refs a second time.

Both scripts pass `--no-release-record`, so running the example leaves nothing
in this repository's release ledger. Drop it and a successful fan-out records
one release per applied component, the same way `chant run --components` does.

Tear the estate down with `npm run teardown`, which deletes the fifteen stacks
apps-first so no stack outlives something that references it.

Against a real account, drop `AWS_ENDPOINT_URL` and the `endpoint` in
`chant.config.ts` and nothing else changes.

## The five things this estate is here to prove

These are the proof lines from chant #2420. Every block below is verbatim
output from running the estate against a local emulator, after changing the
`DisplayName` of `network`'s SNS topic and rebuilding that one template.

The change signal comes first, and it names stacks:

```
$ chant lifecycle affected --base HEAD --json
{ "changed": ["network"], "dependents": [], "indeterminate": ["app-01", ... "cluster-b"] }
```

Fourteen of the fifteen stacks are `indeterminate`, because each declares a
CloudFormation parameter and a source diff cannot judge a value that arrives at
deploy time. An indeterminate stack the walk reaches is selected like any other
dependent, so they all run. One the walk does not reach would be reported and
left undecided, which is the third outcome this model refuses to collapse.

### 1. A plan-only invocation prints the derivation and dispatches nothing

```
$ chant components fan-out --base HEAD --dry-run --gate release
fan-out: 15 selected, 0 unaffected, 0 indeterminate
  wave 1: network
  wave 2: cluster-a, cluster-b
  wave 3: app-01, app-02, app-03, app-04, app-05, app-06, app-07, app-08, app-09, app-10, app-11, app-12
  plan: sha256:7d590c7fda699907736ffe6049eab476acc63e24f39bf0396a637da1285aa2ec
  approve: chant approve fan-out release --plan sha256:7d590c7fda699907736ffe6049eab476acc63e24f39bf0396a637da1285aa2ec
```

Three waves, derived from a change to `network` alone. No file in this project
states that order.

### 2. The run applies exactly what the plan named, in the printed order

```
$ chant components fan-out --base HEAD --env local --gate release --resume .chant/fan-out.json
...
applied: app-01, app-02, app-03, app-04, app-05, app-06, app-07, app-08, app-09, app-10, app-11, app-12, cluster-a, cluster-b, network
fan-out completed: 15 applied, 0 failed, 0 blocked
```

The emulator agrees about the order, and about the wiring:

```
$ aws cloudformation describe-stacks --query 'sort_by(Stacks,&CreationTime)[].[StackName,CreationTime]'
network    05:33:08
cluster-b  05:33:10
cluster-a  05:33:10
app-10     05:33:12
app-06     05:33:12
...

$ aws logs describe-log-groups --query 'logGroups[].logGroupName'
/chant/fan-out-estate/app-01/fan-out-estate-cluster-a
/chant/fan-out-estate/app-07/fan-out-estate-cluster-b
```

Three timestamps for three waves, and no apply preceded its dependency. Each
app's log group name carries its own cluster's table name, which is a value
only that cluster produces and only `stackOutput` could have supplied.

### 3. One approval covers the set, and the printed digest is what approves it

```
$ chant components fan-out --base HEAD --env local --gate release --resume .chant/fan-out.json
...
gated: nothing ran. Waiting on "release" on "fan-out".
  expires: 2026-09-14T05:32:53.025Z
approve : chant approve fan-out release --plan sha256:7d590c7fda699907736ffe6049eab476acc63e24f39bf0396a637da1285aa2ec
$ echo $?
3
```

One gate over fifteen components, not fifteen approvals. Nothing ran. Running
`chant approve` with that digest and repeating the identical command is what
produced the block in section 2 above.

The digest identifies the derivation: who runs, in what order, off which edges.
A fan-out that derives differently is a different change and the standing
approval does not cover it.

### 4. A failure blocks its own subtree, and the other branch still finishes

Give `cluster-a` a plausible authoring mistake. Add a FIFO queue whose name does
not end in `.fifo`, which synthesizes and lints but which SQS refuses at apply
time:

```ts
// src/cluster-a/resources.ts
export const clusterAEvents = new Queue({
  QueueName: "fan-out-estate-cluster-a-events",
  FifoQueue: true,
  SqsManagedSseEnabled: true,
  Tags: tags,
});
```

```
$ npm run build:clusters && chant components fan-out --base HEAD --env local --resume .chant/fan-out.json
fan-out: 15 selected, 0 unaffected, 0 indeterminate
  wave 1: network
  wave 2: cluster-a, cluster-b
  wave 3: app-01, app-02, ... app-12
  plan: sha256:7d590c7fda699907736ffe6049eab476acc63e24f39bf0396a637da1285aa2ec
applied: app-07, app-08, app-09, app-10, app-11, app-12, cluster-b, network
failed: cluster-a
  app-01: blocked by "cluster-a", so it never ran
  app-02: blocked by "cluster-a", so it never ran
  app-03: blocked by "cluster-a", so it never ran
  app-04: blocked by "cluster-a", so it never ran
  app-05: blocked by "cluster-a", so it never ran
  app-06: blocked by "cluster-a", so it never ran
fan-out failed: 8 applied, 1 failed, 6 blocked
```

Six apps are `blocked`, not `failed`, and each names `cluster-a` rather than
whatever sat immediately above it. `cluster-b` and its six apps share no edge
with the failure, so they went out and say so. That is the whole reason a
fan-out has its own runner rather than stopping the estate the way
`chant run --components all` deliberately does.

### 5. The re-run skips what already landed and finishes

Put the `.fifo` suffix back, rebuild, and run the identical command:

```
$ npm run build:clusters && chant components fan-out --base HEAD --env local --resume .chant/fan-out.json
fan-out: 7 selected, 0 unaffected, 0 indeterminate, 8 held back
  wave 1: cluster-a
  wave 2: app-01, app-02, app-03, app-04, app-05, app-06
  seeded from an earlier run: network
  not running (8):
    app-07     already-applied
    app-08     already-applied
    app-09     already-applied
    app-10     already-applied
    app-11     already-applied
    app-12     already-applied
    cluster-b  already-applied
    network    already-applied
  plan: sha256:7d590c7fda699907736ffe6049eab476acc63e24f39bf0396a637da1285aa2ec
applied: app-01, app-02, app-03, app-04, app-05, app-06, cluster-a
fan-out completed: 7 applied, 0 failed, 0 blocked
```

Eight components are named as `already-applied` rather than silently missing.
`network` moves into `seeded from an earlier run`, because `cluster-a` still
needs its outputs and it is no longer in the run. The digest is the same string
as before, carried rather than recomputed, so an approval already given still
stands. Finishing an interrupted fan-out means repeating the command.

## Related

- chant #2417 built the derivation, the ordering and the runner.
- chant #2420 put a command over them and added this estate.
- `examples/adopt-alb-services` is the smaller version of the cross-stack
  wiring: one producer stack and two consumers.
- `examples/components-aws-e2e` is the shortest path from synthesis to a
  deployed stack on the emulator.
