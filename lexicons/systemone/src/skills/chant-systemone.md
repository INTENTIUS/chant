---
skill: chant-systemone
description: Ask a workspace's decision points through a Jev-compatible backend with the decide Op activity
user-invocable: true
---

# Decision points asked through a typed-decision model

## What this lexicon covers

A workspace declares its decision points in a points file (ws-058): a typed question (`noul`, `choice` or `score`), the inputs it reads, each named as a read-contract output, and a chain of deciders, a table, then a model, then a quorum of people. This lexicon adds the `decide` Op activity, which asks a point for one set of inputs and records the answer. It calls the backend the point's model decider names over the `POST /v1/systemone` wire format, which TypeSafe's Jev speaks and so do several local servers.

It declares no resources. The answer is written by core's `points ask` path, so the threshold, the proposal a person confirms, the reuse of an existing answer and the escalation are core's.

## Configure a backend

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-systemone";

export default {
  lexicons: ["systemone"],
  systemone: {
    backends: {
      systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } },
    },
  },
} satisfies ChantConfig;
```

The name (`systemone`) is what a point's model decider writes as `backend`. A key is `{ env }` or a brokered capability, `{ capability: "inference", member: "box" }`, which must be declared on that member's `box.capabilities` with a broker. Never write the key itself: SYS001 fails it.

## Ask a point from an Op

```ts
import { Op, phase } from "@intentius/chant/op";
import { decide } from "@intentius/chant-lexicon-systemone";

export default Op({
  name: "tier-work",
  overview: "Ask which builder tier builds W-002",
  phases: [phase("Decide", [decide("slice-tier", { read: { "work-item": "W-002" }, subject: "W-002" })])],
});
```

`read` names what to read through the read contract, by output: a record, decision or work item by id, or a member by name. Other outputs go in `inputs` as the read contract printed them.

## What the step returns

`{ id, path, state, open, answer, reused, written, decider, model, backend, confidence, threshold, escalations, missing }`. A model's answer is `proposed` and `open`: a person confirms it with `chant workspace points answer <id> --answer <value> --by <name>`. An answer never authorizes anything on its own.

## When the backend is unreachable

The point's model decider says what happens: `unreachable: "escalate"` (the default) records the question open for people with the reason, and `"fail"` writes nothing and fails the step.
