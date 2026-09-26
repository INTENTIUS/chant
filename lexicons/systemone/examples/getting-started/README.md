# Getting started with systemone

One Op, `tier-work`, with one `decide` step. It asks the `slice-tier` decision
point for work item W-002 and records the answer.

The Op runs inside a workspace that declares the point: a record kind with an
`answers` block names the points file, as `reference-workspace/answers/` does
in this repository. The backend is configured in `chant.config.ts` under the
name the point's model decider uses.

```bash
export TYPESAFE_API_KEY=...        # or point the backend at a local server
chant build                       # validates the step against the decide contract
chant run tier-work               # answered by a table row, or waiting on an open question (exit 3)
chant workspace points --open     # the question, proposed or escalated, with the model's confidence
```
