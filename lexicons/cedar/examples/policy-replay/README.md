# policy-replay

A policy set replayed against a recorded event trace, with the verdicts it must
reach written down beside it.

```
npm run build
npx chant run policy-replay
```

## What the build produces

`src/policies.ts` declares three things and `chant build` writes all of them:

| declaration | emitted |
|---|---|
| `ownerRead` (`Policy`) | `dist/policies.cedar` and the JSON policy set |
| `readAfterLogin` (`TemporalPolicy`) | `dist/policies.dw` |
| `events` (`TemporalEventSchema`) | `dist/events.dwschema` |

`schema.cedarschema` is a project file rather than an emitted one — it is the
action schema `--policy-schema` reads, and the same file `cedar.schema` points
at in `chant.config.ts`. It declares two namespaces because the project has two
surfaces: `App` is the application's own model, `Drupe` is the gateway in front
of it, which is where the recorded session trace comes from.

## Why replay is not a build check

`ownerRead` is decidable from the source: given the schema, a build can say
whether it parses, whether it type-checks, and what it applies to. That is what
the CEDC/CEDS/DWDC checks already do.

`readAfterLogin` is not. What it decides depends on a history:

```
permit (principal, action == Drupe::Action::"Read", resource)
when temporal {
    formerly within 1h Drupe::Action::"Login"::response{ input.user: context.input.user }
};
```

A read is permitted or not depending on whether that user logged in in the last
hour. Nothing in the source says. So the check has to be a replay against real
decision history, and the answer changes as the history does — which puts it on
the **observe** end of the lifecycle dial, next to `WorkflowAuditOp`, with a
finding mode as the reconcile step.

## The trace

`trace/read-after-login.log` is the recorded history, adapted from
[dogwood-policy/dogwood](https://github.com/dogwood-policy/dogwood)
`@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c` (Apache-2.0),
`dogwood-docs/examples/read_after_login`. Four lines: a login request, a login
response, a read ten seconds later, and a read two hours later.

`trace/read-after-login.ts` is the same trace as typed events, and a test
asserts the `.log` is byte-for-byte what the builder renders — so the fixture
cannot drift from the surface that builds it.

**The `.log` has no attribution header** because the trace format has no comment
syntax at all. A `//` is an ordinary part of a value (which is how URLs survive
in a trace), so a header line would be read as an event and rejected with
`timepoint must start with @`. The attribution is here instead.

### Both bags, or the check silently weakens

Each line carries two field bags and they are not the same bag:

```
@10 scope(…) request_context(input: { user: "alice" }) Drupe::Action::"Read"::request(input: { user: "alice" }, callerPrincipal: …)
             └── the Cedar request is built from this   └── temporal predicates match against this
```

The predicate above compares the *past login's* `input.user`, out of the logged
record, against the *current request's* `context.input.user`, out of the
`request_context` envelope. Fill in one and not the other and the replay still
exits 0 with a verdict that tested half of what it claims.

So `traceEvent()` writes a `context` group into both bags by default, and
getting the weaker trace takes an explicit `bags: "record-only"` on the event.
`auditTrace()` applies the same check to a trace this repo did not build — a
history fetched from somewhere else, which is where the follow-on AgentCore
source will arrive.

Action names have the same shape of trap: `Drupe::Action::"Read"`, never `Read`.
A short name leaves every temporal predicate unmatched while Cedar still
authorizes. `traceEvent()` rejects one at construction.

## The expectations

```ts
{ timestamp: 10,   verdict: "allow", determiningRules: [0] }
{ timestamp: 7200, verdict: "deny" }
```

Written against timestamps rather than against the decision-stream index,
because they are not the same number: `Login::response` is history-only under
the default event schema, so it contributes to the window and produces no
verdict. Four trace lines, three decision points.

`determiningRules` is the second half of the assertion. A decision that comes
out right for the wrong reason — the correct verdict, carried by a different
rule — is drift the verdict alone cannot show.

## Running it

The Replay phase shells to upstream's `dogwood` CLI. There is no npm package
and no wasm build; build the binary from the repository above and point chant at
it:

```
export CHANT_DOGWOOD_BINARY=/path/to/dogwood
npx chant run policy-replay
```

Without a binary the phase fails and says where it looked. It does not degrade
to a pass — a replay that did not happen is not a replay that found nothing,
and the same rule is why nothing in chant's gating CI executes the binary.
