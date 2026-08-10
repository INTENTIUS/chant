---
skill: chant-cedar-dogwood
description: Author dogwood temporal policies with the cedar lexicon's typed builders — the parser primitives, the macro caveat, the validation split, AgentCore embedding, and replay
user-invocable: true
---

# Temporal Policies with the Dogwood Dialect

## Read this part first

Dogwood is pre-release, and the framing matters more than usual because it
changes what you should write.

Upstream (`dogwood-policy/dogwood`, Apache-2.0) says on its own README, in
bold, that it is **not intended for production use**. It is a reference
interpreter with enumerated gaps: no event timestamp validation, no event
authentication, no trace durability, unsandboxed Rhai in providers, no audit
logging, no multi-tenancy isolation, and an `http_get` provider with no SSRF
protection.

It also has no versioning story at all. Zero tags, zero releases, no changelog.
The crate reports `1.0.0` because it is published to an Amazon-internal
registry, and every future sync will also report `1.0.0`. The repository is a
read-only mirror: content arrives as squashed "Sync from internal source"
commits from a publish bot, against a repository nobody outside Amazon can see,
at a cadence of roughly one sync every three days over its public life.

chant pins a git SHA plus the blob hashes of seven files in
`src/dogwood/upstream.ts`. Do not tell a user this surface is stable. Do tell
them what is pinned and what a sync can move.

## The one distinction to get right

**`formerly`, `previous`, `since`, `exists`, `tp()`, `count for … where` and
`sum … for … where` are the parser primitives.** They are the entire temporal
keyword set in upstream's grammar, and they are what the typed builders target.

**`count_within`, `sum_within`, `count_distinct_within` and `bind` are macros**
in a swappable default library (`configuration/default_macros.dw`). A caller
who passes `--macros` replaces that library wholesale, so a policy built on
them is built on an assumption about the far end.

**`once` does not ship at all.** It appears in upstream's examples as an
ordinary user-defined macro and is in no library. (The grammar rule behind
`formerly` is internally named `once_op`, which is where the confusion comes
from.) If a user asks for `once`, define it as a macro or use `formerly`
directly — do not emit a bare `once(…)` call and hope.

So: the four aggregates are expressible as **calls**
(`dogwood.countWithin(…)`), never as operators. A missing macro at the far end
is a comprehensible error. A builder that emits a name the callee's library
does not define is a mystery.

The way to stop assuming is to ship the definitions:

```typescript
import { TemporalMacroLibrary, dogwood } from "@intentius/chant-lexicon-cedar";

// Upstream's four definitions, verbatim, into the project's own macros.dw.
export const macros = new TemporalMacroLibrary({ macros: dogwood.defaultMacroLibrary() });
```

With `inline: true` they go at the top of `policies.dw` instead, and a policy
set's own `def` shadows a same-named library macro — the strongest form,
because the definitions travel with the policies.

## Authoring

```typescript
import { TemporalPolicy, TemporalEventSchema, dogwood } from "@intentius/chant-lexicon-cedar";

export const events = new TemporalEventSchema({ schema: dogwood.defaultEventSchema() });

export const readAfterLogin = new TemporalPolicy({
  annotations: { id: "read_after_login" },
  action: { eq: 'Drupe::Action::"Read"' },
  whenTemporal: [
    dogwood.formerly(
      "1h",
      dogwood.predicate('Drupe::Action::"Login"', "response", {
        "input.user": dogwood.ctx("input.user"),
      }),
    ),
  ],
});
```

Emits:

```
@id("read_after_login")
permit (
  principal,
  action == Drupe::Action::"Read",
  resource
)
when temporal {
    formerly within 1h Drupe::Action::"Login"::response{ input.user: context.input.user }
};
```

### Clause forms

| Prop | Emits |
|---|---|
| `when` / `unless` | `when { … }` — Cedar expression strings, same as `Cedar::Policy` |
| `whenGuardrails` / `unlessGuardrails` | `when guardrails { … }` — a Cedar expression with a tag upstream discards when lowering |
| `whenTemporal` / `unlessTemporal` | `when temporal { … }` — the temporal sub-language |

### Windows

`formerly`, `previous` and `since` all take a mandatory window: an integer and
one of `s`, `m`, `h`, `d`. Nothing else parses. The builders take it as an
argument, so a windowless operator is unrepresentable — do not reach for
`dogwood.raw()` to work around a window you do not want, because there is no
such form.

Every operator is past-only. There is no future operator and no way to write
one. A user asking for "deny if X happens later" needs a different design.

### Terms

Numbers and booleans lift. A bare string does not, on purpose: `"alice"` is a
Cedar string literal and `alice` is a binder reference, and guessing is how a
policy silently stops matching. Say which:

| Builder | Renders |
|---|---|
| `dogwood.str("alice")` | `"alice"` |
| `dogwood.varRef("a")` | `a` |
| `dogwood.ctx("input.user")` | `context.input.user` |
| `dogwood.scopeRef("principal", "dept")` | `principal.dept` |
| `dogwood.entityUid('Drupe::OAuthUser::"alice"')` | `Drupe::OAuthUser::"alice"` |

### An aggregate, from the primitive

```typescript
export const rateLimited = new TemporalPolicy({
  annotations: { id: "rate_limited" },
  action: { eq: 'Drupe::Action::"Transfer"' },
  whenTemporal: [
    dogwood.compare(
      dogwood.count(
        [dogwood.typedBinder("t", "Timepoint")],
        dogwood.formerly(
          "15m",
          dogwood.and(dogwood.predicate('Drupe::Action::"Transfer"', "request"), dogwood.tp("t")),
        ),
      ),
      "<",
      5,
    ),
  ],
});
```

That is what `count_within` expands to. Writing it directly costs four lines
and depends on nothing at the far end.

## The event schema, and the pin

`.dwschema` is the optional service half of the schema; the required half is
the Cedar `.cedarschema` the rest of the lexicon already generates from. They
are two halves of one schema, not competing formats.

The default event schema pins `callerPrincipal = principal` on every kind, so
every temporal predicate is correlated to the deciding request's principal and
other principals' events are invisible.

**Supplying any event schema opts out of upstream's default wholesale.** A
schema emitted without a pin does not merely fail to add a correlation — it
removes one the author probably assumed, and every predicate in the set starts
matching across principals. `dogwood.defaultEventSchema()` carries the pin;
dropping it is a named argument that stamps a comment into the emitted file:

```typescript
dogwood.defaultEventSchema({ pinCallerPrincipal: false });
```

DWDS010 warns about an unpinned emitted schema. That is report-only — chant
does not know which the author wanted, only that the choice should be visible
in a diff.

`max_window` caps look-back for the whole set; absent, it is 24h — the same 24h
that applies when no schema is supplied at all.

## Deploying to AgentCore

`AWS::BedrockAgentCore::Policy` is the vehicle. Its `Definition` is a two-arm
`oneOf` — `Cedar.Statement` for plain Cedar, `Policy.Statement` for anything
else — and a `.dw` policy travels in the second arm.

```typescript
import { agentCoreStagedPolicy } from "@intentius/chant-lexicon-cedar";

new BedrockAgentCorePolicy({
  PolicyEngineId: engine.ref(),
  ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
});
```

`agentCorePolicyDefinition(name, policy)` picks the arm from the policy itself.
Templates are refused — AgentCore's union has no template-linked arm, so a
statement carrying `?principal` or `?resource` throws at authoring time rather
than failing at deploy.

`EnforcementMode` stages the rollout: `"log-only"` is evaluated on every request
with its decision observed rather than returned, `"enforce"` binds. Start a
temporal policy log-only — whether it fires depends on traffic nobody has
replayed. Promotion is a one-token diff.

The resource carries a statement and nothing else, so the event schema is
registered with the engine separately; DWDC013 warns when temporal text is
embedded and no `.dwschema` was emitted beside it.

## The validation split

Explain this split when a user asks why something did or did not fail.

Always, gating, no binary anywhere:

| Check | Catches |
|---|---|
| DWDC010 | A temporal predicate naming an event kind the emitted `.dwschema` never declares |
| DWDC011 | A window past `max_window` (or upstream's 24h default) — macro-call intervals count |
| DWDC012 | A `formerly`/`previous`/`since` with no `within` window |
| DWDC013 | An AgentCore-embedded temporal statement with no `.dwschema` emitted beside it (warning) |
| DWDS010 | An emitted event schema that pins nothing (warning) |

Only when the `dogwood` binary is present:

| Check | Catches |
|---|---|
| DWDE010 | Everything `dogwood validate` catches — macro expansion, the temporal type check, the Cedar body against the action schema |
| DWDE011 | The `dogwood lower` output failing Cedar's own validator via `@cedar-policy/cedar-wasm` |

Binary resolution order: an explicit `configureDogwoodCli({ binary })`, then
`$CHANT_DOGWOOD_BINARY`, then `cedar.dogwood.binary` in a `chant.config.json`,
then `dogwood` on `PATH`. There is no published build — it is `cargo build
--release` from the pinned revision.

When it is absent, DWDE010 emits exactly one `info` finding naming the binary,
where chant looked, and the issue. It never silently passes: a check that
quietly succeeds when it could not run is claiming a guarantee it did not make.

Nothing in gating CI runs the binary, by design.

### Do not read exit codes

If you write anything that shells to the CLI: exit 2 means both "policy set
rejected" and clap's usage error for an unknown flag, and upstream's own guide
claims 1 for the latter. The JSON on stdout decides, in both directions. There
are two JSON shapes — a validate report (`passed`, `errors[]`, `warnings[]`)
and a bare fatal error object with the same diagnostic fields flattened plus
`related[]`. A run that produced neither is "could not be used", never "your
policy is bad".

## Replay

A temporal policy is not decidable from its source — whether `formerly within
1h …` fires depends on history nobody has replayed — so the check is a replay
against recorded traffic. That ships as `PolicyReplayOp`:

```typescript
import { PolicyReplayOp } from "@intentius/chant-lexicon-cedar";

export const { op } = PolicyReplayOp({
  name: "policy-replay",
  policiesPath: "dist/policies.dw",
  policySchemaPath: "schema.cedarschema",
  eventSchemaPath: "dist/events.dwschema",
  tracePath: "trace/read-after-login.log",
  expect: [
    { timestamp: 10, verdict: "allow", determiningRules: [0] },
    { timestamp: 7200, verdict: "deny", note: "the login is two hours stale" },
  ],
  onFinding: "report",
});
```

Three phases — Artifacts (`chantBuild`, skippable with `buildScript: false`),
Replay (`dogwoodReplay`, writes `dist/dogwood-replay.json`), Report
(`dogwoodReplayReport`, acts on `report | issue | pull-request`).
`failOnDivergence` defaults to false: an observe-dial Op reports. The composite
ships from cedar and carries no dependency on the temporal lexicon; a scheduled
form is a project-side `TemporalSchedule` pairing.

Build traces with `dogwood.traceEvent()` rather than by hand. Two traps it
exists to close, and both are worth naming whenever a user assembles a fixture:

1. **Both bags.** A trace line carries a `request_context(...)` envelope, which
   the Cedar request is built from, and a trailing logged record, which temporal
   predicates match against. A field both halves need must be in both.
   `traceEvent()` writes a `context` group into both by default; getting the
   weaker trace takes an explicit `bags: "record-only"` / `"context-only"`.
   Populate one bag only and nothing errors — the other check silently weakens.
2. **Fully-qualified action names.** `Drupe::Action::"Transfer"`, never
   `Transfer`. A bare name still authorizes through Cedar while every temporal
   predicate quietly fails to match. `traceEvent()` rejects one at construction.

`dogwood.auditTrace(events)` applies the same checks to a trace chant did not
build (`single-bag`, `no-request-context`, `empty-record`, `out-of-order`), and
`dogwood.traceFixture(events)` throws rather than handing back a weakened one.

Write expectations against `timestamp`, not `index`: `index` is the position in
the decision stream, and a history-only event (any kind the schema does not
mark `decision`) contributes history and no verdict, so the two do not line up.
`determiningRules` catches a decision that is right for the wrong reason.

Replay exits 0 even when every verdict is DENY, so the activity reads the JSON
rather than the exit status — and a run that could not happen throws instead of
reporting zero divergences.

## What chant does not do

- **No lowering.** `dogwood lower` owns that; a reimplementation would drift on
  the next sync. Where the lowered form is wanted, chant shells to the binary.
- **No request-time evaluation.** The policy engine in front of the traffic
  decides; chant has no seat there. The offline half is `PolicyReplayOp`, which
  replays recorded history through upstream's interpreter.
- **No gate.** Dogwood is a target, the same as Cedar. Organizational policy in
  chant is TypeScript post-synth checks.

## Reference

Full pages: `/chant/lexicons/cedar/dogwood/`, and from there temporal policies,
event schemas, validation and replay.
