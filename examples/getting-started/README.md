# getting-started — the golden teaching example

The one example that teaches chant from the core up. It is built in levels. Each
level adds one capability over the **same declarations**, so you start with pure
synthesis and end with a full deployment workflow without rewriting anything.

Start here if you are new to chant. Stop at whatever level answers your question.

> **Status:** L1 is here now. L2–L5 land in follow-up work — see
> [#216](https://github.com/INTENTIUS/chant/issues/216). The level plan below is
> the target shape, not a claim that every level already exists.

## The levels

| Level | Adds | Needs |
|---|---|---|
| **L1 — synthesis** (this directory) | typed resources → `chant build` → spec-native output, plus `chant lint` and `chant graph` | nothing — no server, no cloud |
| **L2 — Ops, local** | wrap the declarations in an Op, run it in-process | nothing |
| **L3 — gate + Temporal** | a human-approval gate | a local Temporal (Docker) |
| **L4 — the lifecycle dial** | observe drift, reconcile, apply | a target environment |
| **L5 — capstone** | the alert-triage app ([#74](https://github.com/INTENTIUS/chant/issues/74)) | the full local stack |

## L1 — what is here

A Lambda that lists objects in an S3 bucket, declared as typed TypeScript.

| File | Teaches |
|---|---|
| `src/main.ts` | typed resources and composites; intrinsics (`Sub`, `Ref`, `AWS.StackName`) |
| `src/params.ts` | a deploy-time input (a CloudFormation Parameter the platform fills in) |
| `src/outputs.ts` | a cross-resource reference (`app.bucket.Arn`) resolved at synthesis |
| `src/tags.ts` | a reused `const` — static config resolved at synthesis |

### Run it

```bash
npm install

# Synthesize spec-native CloudFormation. No AWS call, no state, no deploy.
npm run build      # → template.json

# Validate meaning, not just structure.
npm run lint

# See the resource dependency graph.
npm run graph
```

`template.json` is standard CloudFormation. You can hand it to
`aws cloudformation deploy` or any pipeline — there is nothing chant-specific in
the output. That is the whole of L1: deterministic, spec-true synthesis.

## A standalone first taste

If you want to run *something* in under a minute with no cloud account and no
Docker, the [`local-op-quickstart`](../local-op-quickstart/) example runs a
one-step Op on the local executor (`chant run hello`). It is the smallest Op
demo and stands on its own; this golden example is the guided path that starts
from synthesis and builds up.
