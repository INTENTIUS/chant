/**
 * The dogwood dialect's docs pages (#1662, epic #1646).
 *
 * Separate from `./docs.ts` because the dialect is a surface inside this
 * lexicon rather than a lexicon of its own: its pages sit in one sidebar group
 * and get written and reviewed together, while `docs.ts` stays the cedar
 * site's own shape. They are wired in as `extraPages` with `sidebar: false`
 * plus a `sidebarExtra` group, so every page is reachable — Starlight does not
 * auto-discover, and a page no sidebar entry points at exists only for whoever
 * types the URL (#1312).
 *
 * The facts here come from the #1657 upstream verification and from this
 * lexicon's own `src/dogwood/`. Where the two ever disagree the code wins: the
 * builders are what a reader will actually run.
 */

// ── Overview ──────────────────────────────────────────────────────

export const dogwoodOverview = `[Dogwood](https://github.com/dogwood-policy/dogwood) is Cedar with temporal
operators. A policy can ask what already happened in a session — was there a
login in the last hour, how much has been transferred in the last fifteen
minutes, has anything touched a classified document since the session started —
so approval-before-action, rate limits and budgets become policy instead of
application code.

A \`.dw\` file is a Cedar policy with extra clause forms. Its head is Cedar's,
byte for byte, and its action schema is an ordinary \`.cedarschema\`.

\`\`\`
@id("read_after_login")
permit (
  principal,
  action == Drupe::Action::"Read",
  resource
)
when temporal {
    formerly within 1h Drupe::Action::"Login"::response{ input.user: context.input.user }
};
\`\`\`

## Pre-release, and what that means here

Upstream calls itself a reference interpreter and says, in bold on its own
README, that it is **not intended for production use**. The gaps it enumerates:
no event timestamp validation, no event authentication, no trace durability,
unsandboxed Rhai in providers, no audit logging, no multi-tenancy isolation,
and an \`http_get\` provider with no SSRF protection.

Most of those are a runtime consumer's problem rather than chant's — chant's
half is authoring, serialization and the walls, and evaluation stays with
Bedrock AgentCore Policy or whatever engine reads the emitted files. The part
that *is* chant's problem is that the language surface can move underneath the
typed builders, which is the next section.

## How upstream is governed

There is no versioning story, and that is a finding rather than a complaint.

| Question | Answer at the pinned revision |
|---|---|
| Tags | None |
| GitHub releases | None |
| Changelog | None |
| Crate version | \`1.0.0\`, declared \`publish = ["brazil"]\` — an Amazon-internal registry, not crates.io |
| Contributions | CONTRIBUTING declares the repo a read-only mirror, not accepting external PRs, not using GitHub issues |
| Stability statement | Nowhere in README, CONTRIBUTING, SECURITY or the guide |

Every content change arrives as one squashed \`Sync from internal source\`
commit from a publish bot, authored against a repository nobody outside Amazon
can see. Over the repo's public life the cadence has been roughly one sync
every three days. A sync is a wholesale tree replacement, so it can retune the
grammar, rename a JSON field or swap the default macro library in a single
commit, and the crate will report \`1.0.0\` either way.

So a chant version gate cannot key off anything upstream publishes. What
\`src/dogwood/upstream.ts\` records instead is a git SHA plus the blob hashes of
seven files — three \`.pest\` grammars, the default macro library, and the three
\`dogwood-cli/src\` files whose report structs are the JSON contract. The whole
tree hash moves on docs-only syncs, which makes it too noisy to gate on.

Three consequences run through everything else on these pages:

- The typed builders target the **parser primitives**, never the named
  aggregates, because the aggregates live in a file a sync can edit and a
  caller can replace. See [Temporal Policies](../dogwood-temporal-policies/).
- The CLI's **JSON report structs** are the integration surface, never its
  human text, because the human renderer is the likelier thing to get
  cosmetically retuned. See [Validation](../dogwood-validation/).
- **Nothing in gating CI runs the binary.** Full \`.dw\` validation is a
  CLI-gated check that says out loud when it did not run.

## A dialect, not a sibling lexicon

k3s beside k3d and forgejo beside github are parallel peers with separate
upstreams. Dogwood is not a peer: it embeds Cedar, a \`.dw\` file stripped of
Cedar semantics is meaningless, and the expensive machinery — schema codegen,
typed entity and action classes, meta-policy lint — is shared verbatim. It
ships as a surface inside this lexicon, with its checks under the \`DWD\` id
family declared on the serializer's \`extraRulePrefixes\`.

## Quick start

\`\`\`typescript
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
\`\`\`

## What comes out

| File | What reads it |
|---|---|
| \`policies.dw\` | \`dogwood validate\` / \`lower\` / \`replay\` |
| \`events.dwschema\` | \`dogwood --event-schema\` — the service half of the schema |
| \`macros.dw\` | \`dogwood --macros\` — a macro library, when one is declared non-inline |
| \`<name>.cedar\`, \`policies.cedar.json\` | The plain-Cedar half of the same policy set, unchanged |

A build with no temporal policies emits none of the first three and behaves
exactly as it did before. A build with both halves emits both from one pass,
with policy ids derived the same way on each leg.

## Deploying it: AgentCore

\`AWS::BedrockAgentCore::Policy\` — generated by the
[aws lexicon](/chant/lexicons/aws/) — is where a temporal policy is actually
deployed. Its \`Definition\` is a two-arm \`oneOf\`: \`Cedar.Statement\` for plain
Cedar, \`Policy.Statement\` for anything else. The second arm is what a \`.dw\`
policy travels in, and it is why the epic picked AgentCore as the target.

\`\`\`typescript
import { agentCoreStagedPolicy } from "@intentius/chant-lexicon-cedar";

new BedrockAgentCorePolicy({
  PolicyEngineId: engine.ref(),
  ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
});
\`\`\`

\`agentCorePolicyDefinition(name, policy)\` picks the arm from the policy itself:
a \`TemporalPolicy\`, or any props carrying a temporal clause, goes to \`Policy\`;
plain Cedar goes to \`Cedar\`. Nothing in the cedar lexicon imports the aws one —
the seam is the data shape, the same rule the AVP embedding follows.

\`EnforcementMode\` is the staging dial, and a temporal rule is the case that
needs it most: \`LOG_ONLY\` is evaluated on every request with its decision
observed rather than returned, so a policy whose behaviour depends on unreplayed
traffic can be watched before it binds. Promotion is one token, \`"log-only"\` to
\`"enforce"\`.

The resource carries a statement and nothing else, so the event schema has
nowhere to live in it and is registered with the engine separately. DWDC013
warns when a build embeds temporal text and emits no \`.dwschema\` beside it,
because a deployed statement whose event kinds nobody registered matches
nothing and stops doing its job without failing.

The worked example is \`lexicons/cedar/examples/agentcore-policy\`.

## What chant does not do

chant does not lower. \`dogwood lower\` compiles a \`.dw\` set to plain Cedar with
the temporal conditions hoisted into \`context.*\` slots; that is upstream's
semantics to own, and a reimplementation would drift the first time a sync
changed it. Where the lowered form is wanted, chant shells to the binary.

chant does not evaluate at request time. Temporal decisions are made by the
policy engine in front of the traffic, and chant has no seat there. What chant
does have is the offline half: \`PolicyReplayOp\` replays a declared set against
recorded history through upstream's own interpreter and reports where the
verdicts diverged from what the policy set was supposed to decide.

## The pages

- [Temporal Policies](../dogwood-temporal-policies/) — the builders, the
  operators, and which of them are macros
- [Event Schemas](../dogwood-event-schemas/) — the \`.dwschema\` surface and the
  \`callerPrincipal\` pin
- [Validation](../dogwood-validation/) — which checks always run and which need
  the binary
- [Replay](../dogwood-replay/) — typed traces, \`PolicyReplayOp\`, and the trap
  that makes half a trace pass silently
`;

// ── Temporal policies ─────────────────────────────────────────────

export const dogwoodTemporalPolicies = `A \`Dogwood::TemporalPolicy\` is a \`Cedar::Policy\` with three extra clause
forms. Upstream's policy grammar differs from Cedar's in exactly one rule:

\`\`\`
cond = { cond_kw ~ (extension_marker | guardrails_tag? ~ "{" ~ expr ~ "}") }
\`\`\`

| Prop | Emits | What it is |
|---|---|---|
| \`when\` / \`unless\` | \`when { … }\` | Ordinary Cedar expression strings, same as \`Cedar::Policy\` |
| \`whenGuardrails\` / \`unlessGuardrails\` | \`when guardrails { … }\` | A Cedar expression with a tag upstream discards when lowering. It marks a clause for a reader; it does not change what the policy means |
| \`whenTemporal\` / \`unlessTemporal\` | \`when temporal { … }\` | The temporal sub-language, dispatched to a different parser |

Clause order in the emitted file is fixed — every \`when\` form, then every
\`unless\` form — rather than taken from the author. Conditions are a
conjunction, so order carries no meaning, and fixing it means a policy that
gains a temporal clause does not reshuffle the clauses already there.

## The primitives

These seven are the whole temporal keyword set in upstream's
\`extension/temporal/grammar.pest\`. Everything else you will read about dogwood
is built out of them.

| Builder | Renders | Notes |
|---|---|---|
| \`formerly(w, φ)\` | \`formerly within 1h φ\` | φ held at some point in the window |
| \`previous(w, φ)\` | \`previous within 30s φ\` | φ held at the immediately preceding timepoint in the window |
| \`since(φ, w, ψ)\` | \`φ since within 1h ψ\` | Infix; φ has held continuously since ψ |
| \`exists(binder, φ)\` | \`exists (total: Long). φ\` | Binds a value for the body to compare |
| \`tp(binder)\` | \`tp(t)\` | Binds the timepoint under evaluation |
| \`count(binders, φ)\` | \`count for (t: Timepoint). where φ\` | The aggregation domain is mandatory |
| \`sum(over, binders, φ)\` | \`sum a for (a: Long), (t: Timepoint). where φ\` | \`over\` names the summed variable |

Plus \`and\`, \`not\`, \`compare\`, and \`predicate\` for an event head.

Two properties of the operator set are worth stating plainly. All of them are
**past-only** — there is no future operator, and no way to write one. And
\`formerly\`, \`previous\` and \`since\` all carry a **mandatory window**: an
integer and one of \`s\`, \`m\`, \`h\`, \`d\`, and nothing else. The builders take the
window as an argument, so a windowless operator has nowhere to live; DWDC012
catches the ones that arrive by other routes.

## Four policies

Approval before action:

\`\`\`typescript
import { TemporalPolicy, dogwood } from "@intentius/chant-lexicon-cedar";

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
\`\`\`

A rate limit, from the \`count\` primitive:

\`\`\`typescript
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
\`\`\`

A budget, from \`sum\` behind a macro, with \`exists\` naming the total:

\`\`\`typescript
import { TemporalMacroLibrary, TemporalPolicy, dogwood } from "@intentius/chant-lexicon-cedar";

const sumFormerly = dogwood.defTemporalMacro(
  "sum_formerly",
  ["?a", "?w", "?body"],
  dogwood.sum(
    "?a",
    [dogwood.typedBinder("?a", "Long"), dogwood.typedBinder("$t", "Timepoint")],
    dogwood.formerly(
      dogwood.macroWindow("?w"),
      dogwood.and(dogwood.macroCondition("?body"), dogwood.tp("$t")),
    ),
  ),
  "Sums the numeric value \`?a\` over occurrences of \`?body\` within window \`?w\`.",
);

export const library = new TemporalMacroLibrary({ macros: [sumFormerly], inline: true });

export const transferBudget = new TemporalPolicy({
  annotations: { id: "transfer_sum_over_100" },
  action: { eq: 'Drupe::Action::"Alert"' },
  whenTemporal: [
    dogwood.exists(
      dogwood.typedBinder("total", "Long"),
      dogwood.and(
        dogwood.compare(
          dogwood.call("sum_formerly", [
            dogwood.varRef("a"),
            dogwood.interval("1h"),
            dogwood.predicate('Drupe::Action::"Transfer"', "request", {
              "input.user": dogwood.varRef("_"),
              "input.amount": dogwood.varRef("a"),
            }),
          ]),
          "==",
          dogwood.varRef("total"),
        ),
        dogwood.compare(dogwood.varRef("total"), ">", 100),
      ),
    ),
  ],
});
\`\`\`

Sequencing, with a guardrail and a break-glass exemption:

\`\`\`typescript
export const noToolAfterSensitiveRead = new TemporalPolicy({
  effect: "forbid",
  annotations: { id: "no_tool_after_sensitive_read" },
  action: { eq: 'Drupe::Action::"Invoke"' },
  whenGuardrails: ['context.input.tool != "audit"'],
  whenTemporal: [
    dogwood.since(
      dogwood.predicate('Drupe::Action::"Read"', "response", {
        "output.classification": dogwood.varRef("c"),
      }),
      "30m",
      dogwood.predicate('Drupe::Action::"Login"', "request"),
    ),
  ],
  unless: ['principal in Drupe::Group::"breakglass"'],
});
\`\`\`

Those four emit this, and the golden test in \`src/dogwood/serialize.test.ts\`
pins it byte for byte:

\`\`\`
// Sums the numeric value \`?a\` over occurrences of \`?body\` within window \`?w\`.
def temporal sum_formerly(?a, ?w, ?body) {
    sum ?a for (?a: Long), ($t: Timepoint). where formerly within ?w (?body && tp($t))
};

@id("read_after_login")
permit (
  principal,
  action == Drupe::Action::"Read",
  resource
)
when temporal {
    formerly within 1h Drupe::Action::"Login"::response{ input.user: context.input.user }
};

@id("transfer_sum_over_100")
permit (
  principal,
  action == Drupe::Action::"Alert",
  resource
)
when temporal {
    exists (total: Long). (sum_formerly(a, 1h, Drupe::Action::"Transfer"::request{ input.user: _, input.amount: a })) == total && total > 100
};

@id("no_tool_after_sensitive_read")
forbid (
  principal,
  action == Drupe::Action::"Invoke",
  resource
)
when guardrails { context.input.tool != "audit" }
when temporal {
    Drupe::Action::"Read"::response{ output.classification: c } since within 30m Drupe::Action::"Login"::request{}
}
unless { principal in Drupe::Group::"breakglass" };

@id("rate_limited")
permit (
  principal,
  action == Drupe::Action::"Transfer",
  resource
)
when temporal {
    (count for (t: Timepoint). where formerly within 15m (Drupe::Action::"Transfer"::request{} && tp(t))) < 5
};
\`\`\`

## Primitives versus macros

This is the distinction to get right, and the reason the builder list above is
shorter than most write-ups of dogwood.

\`count_within\`, \`sum_within\` and \`count_distinct_within\` are **not**
operators. They are macros defined in
\`dogwood-language/configuration/default_macros.dw\`, alongside \`bind\`:

\`\`\`
def temporal count_within(?w, ?s) {
    count for ($t: Timepoint). where (formerly within ?w (?s && tp($t)))
};
\`\`\`

\`once\` is not even that. It appears in upstream's examples as an ordinary
user-defined macro and ships in no library at all. (The grammar rule behind
\`formerly\` is internally named \`once_op\`, which is where the confusion
starts.) If you want \`once\`, define it — chant will not pretend it exists.

A caller who passes \`--macros\` replaces the entire default library, so a
policy built on \`count_within\` is a policy built on an assumption about the
far end. chant therefore exposes the four as **calls**:

\`\`\`typescript
dogwood.countWithin("15m", dogwood.predicate('Drupe::Action::"Transfer"', "request"));
// count_within(15m, Drupe::Action::"Transfer"::request{})
\`\`\`

A call that resolves to nothing at the other end is a missing-macro error,
which is comprehensible. A first-class builder emitting a name the callee's
library does not define would be a mystery.

The way to stop assuming is to emit the definitions yourself:

\`\`\`typescript
import { TemporalMacroLibrary, dogwood } from "@intentius/chant-lexicon-cedar";

export const macros = new TemporalMacroLibrary({ macros: dogwood.defaultMacroLibrary() });
\`\`\`

That writes \`macros.dw\` with upstream's four definitions verbatim. With
\`inline: true\` they go at the top of \`policies.dw\` instead, and a policy set's
own \`def\` shadows a same-named library macro — which makes inlining the
strongest form: the definitions travel with the policies and win over whatever
\`--macros\` the caller supplies.

## Writing macros

\`\`\`typescript
dogwood.defTemporalMacro("once", ["?w", "?s"], dogwood.formerly(dogwood.macroWindow("?w"), dogwood.macroCondition("?s")));
dogwood.defCedarMacro("is_small", ["?n"], "?n < 100");
\`\`\`

Two sigils, and they are not interchangeable:

- \`?p\` splices the call-site argument literally. Build one with
  \`macroWindow("?w")\` in window position, \`macroCondition("?s")\` in condition
  position, \`macroTerm("?a")\` in term position.
- \`$t\` is a fresh binder the macro introduces, gensym'd at every expansion.

Both are legal only inside a macro body; upstream's well-formedness pass
rejects them anywhere else, so the builders validate them at definition time.

A call site supplies a window as a **bare interval** — \`once(1h, …)\`, no
\`within\` — because the keyword belongs to the operator and stays in the body.
That is \`dogwood.interval("1h")\`.

## Terms

Numbers and booleans lift to literals. A bare string does not, and that is
deliberate: \`"alice"\` is a Cedar string literal and \`alice\` is a binder
reference, and guessing which one was meant is how a policy silently stops
matching.

| Builder | Renders |
|---|---|
| \`str("alice")\` | \`"alice"\` |
| \`varRef("a")\` | \`a\` |
| \`ctx("input.user")\` | \`context.input.user\` |
| \`scopeRef("principal", "dept")\` | \`principal.dept\` |
| \`entityUid('Drupe::OAuthUser::"alice"')\` | \`Drupe::OAuthUser::"alice"\` |
| \`decimalOf("1.50")\` | \`decimal("1.50")\` |
| \`arrayOf(1, 2)\` | \`[1, 2]\` |
| \`wildcard()\` | \`*\` |

## Precedence, and who handles it

The renderer parenthesises rather than relying on the reader knowing the
grammar. \`!\` binds tighter than \`since\` and \`&&\`, so \`!a since within W b\`
negates only \`a\`; an aggregate's \`where\` body is greedy, so
\`count for (…). where φ == 3\` would read \`== 3\` as part of φ. Aggregates and
macro calls in comparison position are wrapped on both sides, and \`exists\`
binds maximally to the right so it is wrapped inside an \`&&\` chain.

## The escape hatch

\`dogwood.raw("formerly within 1h …")\` emits temporal source verbatim. It is
the one builder that can produce something the walls exist to catch, which is
why the walls read the serialized text rather than the in-memory tree — see
[Validation](../dogwood-validation/).

## Next

- [Event Schemas](../dogwood-event-schemas/) — what the \`request\`/\`response\`
  kinds in those predicates come from
- [Validation](../dogwood-validation/) — what checks a policy set before it
  leaves the build
`;

// ── Event schemas ─────────────────────────────────────────────────

export const dogwoodEventSchemas = `A dogwood policy set is checked against two schemas, and only one of them is
required.

| Half | Format | Flag | Required |
|---|---|---|---|
| Action schema | Cedar \`.cedarschema\` — entities, actions, each action's \`context\` | \`--policy-schema\` | Yes, for \`validate\`, \`lower\` and \`replay\` |
| Service schema | \`.dwschema\` event DSL, a \`providers.json\`, a \`.dw\` macro library | \`--event-schema\`, \`--providers\`, \`--macros\` | No |

The action schema is the one the rest of this lexicon already generates from —
see [Schema](../schema/). This page is about the other half.

With all three service flags omitted, upstream falls back to
\`ServiceSchema::defaults()\`: \`request\` (deciding), \`response\` and \`error\`
kinds, a universal \`pin callerPrincipal = principal\`, a 24h \`max_window\` cap,
no providers, and the embedded default macro library.

## The \`.dwschema\` surface

The grammar is 136 lines of pest and purely syntactic: an optional
\`max_window\` directive, then a sequence of event declarations.

\`\`\`
max_window = 30d

decision event <A>::request {
    ...inputs(A),
    pin callerPrincipal: principalType(A) = principal,
    callerResource: resourceType(A),
    requestId: String,
}
\`\`\`

\`A\` is a symbolic action binder, not an action. **The file names no actions at
all** — it says what shape an event of each kind has, for whichever action it
is derived against. That is why DWDC010 can check a predicate's event *kind*
against the emitted schema but not its action: the action half of that check
lives in the \`.cedarschema\`, and it is the CLI's to make.

Event kind names are author-defined. \`request\`, \`response\` and \`error\` are
conventional, not fixed.

| Builder | Emits |
|---|---|
| \`spreadInputs()\` / \`spreadOutputs()\` | \`...inputs(A)\` / \`...outputs(A)\` |
| \`field("requestId", concrete("String"))\` | \`requestId: String\` |
| \`field("callerResource", resourceType())\` | \`callerResource: resourceType(A)\` |
| \`field("meta", record([…]))\` | a nested record, addressed as \`meta.member\` |
| \`pinnedField(name, type, pinPrincipal())\` | \`pin name: … = principal\` |
| \`pinnedField(name, type, pinContext("input.user"))\` | \`pin name: … = context.input.user\` |

A pinned field must be a leaf; upstream requires the \`pin\` prefix and the
\`= …\` clause together, and the builder enforces both rather than deferring to
the parser.

## The default, and the pin

\`\`\`typescript
import { TemporalEventSchema, dogwood } from "@intentius/chant-lexicon-cedar";

export const events = new TemporalEventSchema({ schema: dogwood.defaultEventSchema() });
\`\`\`

That reproduces upstream's \`pinned.dwschema\` — the shape
\`ServiceSchema::defaults()\` uses — and emits \`events.dwschema\`:

\`\`\`
// The default event-schema shape: request/response/error, each correlated to
// the deciding request's principal.

decision event <A>::request {
    ...inputs(A),
    pin callerPrincipal: principalType(A) = principal,
    callerResource: resourceType(A),
    requestId: String,
    sessionId: String,
}

event <A>::response {
    ...inputs(A),
    ...outputs(A),
    pin callerPrincipal: principalType(A) = principal,
    callerResource: resourceType(A),
    requestId: String,
    sessionId: String,
}

event <A>::error {
    ...inputs(A),
    pin callerPrincipal: principalType(A) = principal,
    callerResource: resourceType(A),
    requestId: String,
    sessionId: String,
}
\`\`\`

**The pin is the thing to understand before writing your own schema.**
\`pin callerPrincipal = principal\` correlates every temporal predicate to the
deciding request's principal: events logged by other principals are invisible
to \`formerly\`, \`since\` and every aggregate over them.

Supplying *any* event schema opts out of upstream's default wholesale. So a
schema emitted without a pin does not merely fail to add a correlation — it
removes one the policy author very likely assumed, and every predicate in the
set starts matching other principals' events.

That is a legitimate design; cross-principal correlation is a reason to write
your own schema. It is also a decision, so chant makes it a named argument:

\`\`\`typescript
export const events = new TemporalEventSchema({
  schema: dogwood.defaultEventSchema({ pinCallerPrincipal: false }),
});
\`\`\`

which stamps the reasoning into the emitted file as a comment, and which
DWDS010 reports as a warning in the build. Neither stops you. Both make the
choice visible in a diff.

## \`max_window\`

The directive caps how far back any operator in the set may look. Absent, the
cap is upstream's 24h default — the same 24h that applies when no schema is
supplied at all.

\`\`\`typescript
dogwood.defaultEventSchema({ maxWindow: "30d" });   // max_window = 30d
\`\`\`

DWDC011 does the arithmetic in TypeScript and fails the build on a window past
the cap, with no binary involved. Where several schemas are emitted the
tightest cap wins, and macro-call intervals count: \`once(48h, …)\` expands
through \`within ?w\` and looks back exactly as far as \`formerly within 48h\`.

## Several schemas

One \`.dwschema\` per file, because \`max_window\` is a single directive at the
top and concatenating two schemas would emit something upstream rejects. A
build with more than one gives each an explicit filename:

\`\`\`typescript
export const gateway = new TemporalEventSchema({
  schema: dogwood.defaultEventSchema({ maxWindow: "30d" }),
  filename: "gateway.dwschema",
});
\`\`\`

Two schemas targeting one filename is a serializer warning and only the first
is written — a silent merge would produce a file that parses as neither.

## Providers

The third service flag, \`--providers\`, takes a \`providers.json\` whose entries
carry \`argumentTypes\`, an \`outputType\` and an \`implementation\`. chant has no
typed builder for it today; the CLI adapter's bundle type accepts provider text
if you assemble it, and the build's planner does not emit one.

One upstream trap worth recording even so: the CLI reads \`--providers\` as raw
text and **never resolves \`scriptFile\`**. Rhai has to be inlined under
\`implementation.script\`, or \`replay\` fails per-evaluation with "rhai
implementation has no script" while \`validate\` and \`lower\` still pass.

## Next

- [Validation](../dogwood-validation/) — DWDC010, DWDC011 and DWDS010 in full
- [Replay](../dogwood-replay/) — where the events these schemas describe
  actually come from
`;

// ── Validation ────────────────────────────────────────────────────

export const dogwoodValidation = `Validation splits by what needs a binary, and the split is the point.

Everything answerable in TypeScript runs on every build and gates. Full \`.dw\`
validation needs upstream's own frontend, which ships as a Rust CLI and nothing
else — no npm package, no wasm build, no bindings — so it runs when the binary
is there and says so out loud when it is not.

| Check | Severity | Needs the binary |
|---|---|---|
| DWDC010 — a temporal predicate names a declared event kind | error | no |
| DWDC011 — a window fits inside \`max_window\` | error | no |
| DWDC012 — \`formerly\`/\`previous\`/\`since\` carries its window | error | no |
| DWDC013 — an embedded AgentCore temporal statement has its event schema emitted | warning | no |
| DWDS010 — an emitted event schema pins something | warning | no |
| DWDE010 — the set validates clean under \`dogwood validate\` | error | yes |
| DWDE011 — the lowered Cedar validates under \`cedar-wasm\` | error | yes |

The DWD family is an ordinary set of
[post-synth checks](/chant/guide/organizational-policy/) under the prefix the
cedar serializer declares in \`extraRulePrefixes\`. There is no second policy
engine here; dogwood is a target, the same as Cedar.

Every one of them reads the **emitted text**, not the in-memory model, for the
same reason the CED checks read \`policies.cedar.json\`: \`chant audit\` runs over
a checked-in artifact chant did not write, and a wall that only fires on
chant's own output is not a wall. It also keeps the builders and the walls
independent — DWDC012 catches a windowless \`formerly\` even though the builders
cannot construct one, because \`raw()\` and a hand-written \`.dw\` both can.

## The TypeScript walls

**DWDC010** compares every predicate head in the temporal regions of a \`.dw\`
file against the event kinds the emitted \`.dwschema\` declares. Upstream rejects
the same thing with code \`extension\`. The check is silent when no \`.dwschema\`
was emitted: with none supplied, \`ServiceSchema::defaults()\` decides the kinds
at the far end, and guessing that a project's out-of-band schema matches
upstream's default would fail builds for a policy set that is fine.

**DWDC011** fires with or without an emitted schema, because the cap applies
either way — 24h by default. See
[Event Schemas](../dogwood-event-schemas/#max_window).

**DWDC012** is the wall behind the typed builders. \`formerly(w, body)\` has
nowhere to put a missing window, so the builders make it unrepresentable; the
check is what covers \`raw()\`, hand-written files, and audits of trees chant
never wrote.

**DWDC013** asks the question prior to DWDC010's, and only of statements that
left the \`.dw\` file behind. A policy embedded in \`Definition.Policy.Statement\`
travels as one string; the engine at the other end cannot match a temporal
predicate until it knows what an event is. A build that embeds temporal text
and emits no \`.dwschema\` has shipped half a policy — the statement deploys, the
predicates match nothing, and a \`formerly\`-guarded forbid stops denying.
Warning rather than error, because a project may register the service schema
through a separate pipeline, and failing that build would be chant asserting a
fact it cannot check.

**DWDS010** is report-only. chant does not know whether cross-principal
correlation was wanted, only that an unpinned schema should not slip through a
review unremarked.

Scanning is confined to the temporal regions of a file — every
\`temporal { … }\` body and every \`def temporal\` body — so a Cedar attribute
named \`since\` is not mistaken for the operator, and \`context.retryWindow == 3\`
is not mistaken for a window.

## The CLI-gated half

**DWDE010** runs \`dogwood validate --format json\` over each emitted policy set
and reports every finding. What it catches that the walls cannot: macro
expansion, the temporal type checker, and the Cedar body checked against the
action schema through upstream's own frontend.

**DWDE011** takes the \`dogwood lower\` output — plain Cedar with the temporal
conditions hoisted into \`context.*\` slots, plus an augmented schema declaring
them — and runs the published \`@cedar-policy/cedar-wasm\` over it. That is a
different validator from the one vendored inside upstream, which makes a
finding here meaningful: it is drift between the Cedar upstream pins and the
Cedar the rest of chant validates against. The #1657 verification put all 86
upstream example bundles through this exact path and every one validated clean
in strict mode.

### When the binary is absent

One \`info\` finding, naming the binary, where chant looked, and the issue. Not
silence. A check that quietly passes when it could not run is claiming a
guarantee it never made.

## Pointing chant at a binary

There is no published build. You build it from the pinned revision:

\`\`\`bash
git clone https://github.com/dogwood-policy/dogwood
cd dogwood && git checkout 5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c
cargo build --release
\`\`\`

Resolution order:

1. An explicit \`configureDogwoodCli({ binary })\` call — taken as given, since
   its caller knows.
2. \`$CHANT_DOGWOOD_BINARY\`.
3. \`cedar.dogwood.binary\` in a \`chant.config.json\`, resolved by walking up
   from the working directory.
4. \`dogwood\` on \`PATH\`.

\`\`\`bash
export CHANT_DOGWOOD_BINARY=/path/to/dogwood/target/release/dogwood
\`\`\`

\`\`\`json
{ "cedar": { "dogwood": { "binary": "./vendor/dogwood" } } }
\`\`\`

The config knob reads \`chant.config.json\` only, and that is a real limitation
rather than an oversight: a post-synth check's \`check()\` is synchronous, while
chant's config loader is async and, under \`chant build --sandbox\`, evaluates a
\`chant.config.ts\` in a child process. JSON is data, so reading it executes
nothing. A project on \`chant.config.ts\` uses the environment variable or the
programmatic override.

A path from the environment or the config that is not executable is resolved
past rather than returned to fail later, and the advisory names where chant
looked.

## Why exit codes decide nothing

Three properties of the CLI shape the adapter, all verified against the pinned
sources.

**Exit 2 is ambiguous.** It covers a rejected policy set *and* clap's own usage
error for an unknown flag — and upstream's published guide claims exit 1 for
the latter. Reading a bare non-zero exit as "your policy is bad" would fail a
build over a flag rename in a sync nobody outside Amazon can review. So the
adapter branches on the JSON on stdout, in both directions: a \`passed: false\`
with a zero exit is still a rejection, and the reverse is still a pass.

**There are two JSON shapes.** A type-check finding arrives in a report —
\`passed\`, \`passed_without_warnings\`, \`errors[]\`, \`warnings[]\`. A fatal parse,
macro or lowering error replaces the whole report with a bare error object
carrying the same diagnostic fields at the top level plus \`related[]\`. Both
normalize into one diagnostic type, so nothing downstream has to know which
arrived.

**A run that produced no usable JSON is neither a pass nor a rejection.** It is
reported at \`warning\` severity as "could not be validated", and the policy set
is explicitly described as neither accepted nor rejected.

Two smaller contract facts the adapter encodes: \`--format json\` writes to
stdout for success and fatal alike, and \`--emit\` is ignored under
\`--format json\` (the JSON always carries all three lowered artifacts), so it is
not passed.

Diagnostic labels are **byte offsets** into the \`.dw\` source, and findings
report them as byte ranges. Converting to line and column would mean
re-deriving line breaks over a file the adapter does not hold, and a wrong line
number is worse than an honest offset.

## Nothing in gating CI runs it

By design, from the epic: upstream instability is priced, not absorbed. The
CLI-gated checks are for a developer with the binary and for on-demand
harnesses in the \`forgejo-runtime-e2e\` shape. \`PolicyReplayOp\` shares that
rule and the same binary discovery — see [Replay](../dogwood-replay/) — with
one difference: a replay step with no binary **fails**, where a build check
with no binary reports and moves on. A check that could not run should not
block a build; a replay that could not run has produced no answer at all.

## Next

- [Replay](../dogwood-replay/) — the third verb, wrapped as an activity and an
  Op rather than as a build check
- [Lint Rules](../lint-rules/) — the cedar half of the same check set
`;

// ── Replay ────────────────────────────────────────────────────────

export const dogwoodReplay = `\`dogwood replay\` evaluates a policy set against a recorded event trace and
returns a verdict per decision point. It is how a temporal policy gets tested
at all.

A plain Cedar policy is decidable from its source: given the schema, a build
can say whether it parses, whether it type-checks, and what it applies to. The
DWDC and CEDC checks already do that. A temporal policy is not decidable that
way — whether \`formerly within 1h Login::response{ … }\` fires depends on a
history nobody has replayed. So the check is a replay against recorded decision
history, and the answer moves as the history does. That puts it on the observe
end of the lifecycle dial, beside \`WorkflowAuditOp\`, with a finding mode as the
reconcile step.

Three pieces ship: a typed trace builder, a \`dogwoodReplay\` activity, and the
\`PolicyReplayOp\` composite that pairs them. The worked example is
\`lexicons/cedar/examples/policy-replay\`.

## The Op

\`\`\`typescript
// ops/policy-replay.op.ts
import { PolicyReplayOp } from "@intentius/chant-lexicon-cedar";
import { readAfterLoginExpectations } from "../trace/read-after-login";

export const { op } = PolicyReplayOp({
  name: "policy-replay",
  policiesPath: "dist/policies.dw",
  policySchemaPath: "schema.cedarschema",
  eventSchemaPath: "dist/events.dwschema",
  tracePath: "trace/read-after-login.log",
  expect: readAfterLoginExpectations,
  onFinding: "report",
});

export default op;
\`\`\`

\`\`\`bash
npx chant run policy-replay
\`\`\`

Three phases:

| Phase | Step | What it does |
|---|---|---|
| Artifacts | \`chantBuild\` | Emits \`policies.dw\`, the \`.cedarschema\` and the \`.dwschema\` the replay reads. Pass \`buildScript: false\` when they are checked in and the phase is dropped rather than run empty |
| Replay | \`dogwoodReplay\` | Runs \`dogwood replay --format json\` over the bundle and the trace, writes the divergence report |
| Report | \`dogwoodReplayReport\` | Reads that report and acts on the finding mode |

The report file (\`dist/dogwood-replay.json\` by default) is the seam between the
last two phases, for the same reason \`dist/fly.json\` is the seam between
\`build:fly\` and \`flyApply\`: Op steps do not hand return values to one another,
so a phase boundary needs an artifact to be a real boundary.

The Replay step carries \`outcomeAttribute: { name: "Divergences", from: "findings" }\`,
so "show me the replays that found something" is one filter rather than a log
read. \`onFinding\` takes \`report | issue | pull-request\`; \`report\` prints the
markdown, and the other two hand back a title and body for whatever opens them
— the cedar lexicon has no forge client and does not grow one, the same
division \`workflowSupplyChainAudit\` draws. \`failOnDivergence\` defaults to
false: an observe-dial Op reports, and a red run is the caller's decision.

The composite ships from cedar, not from temporal, because it hands back an Op
and nothing else. It imports \`@intentius/chant/op\` and carries no dependency on
the temporal lexicon. A project that wants it scheduled pairs it with a
\`TemporalSchedule\` of its own — two lines, project-side, rather than a config
flag that would drag the dependency in for everyone.

## Typed traces

\`traceEvent()\` builds one line. \`renderTrace()\` renders a list.
\`traceFixture()\` does both and refuses to hand back a trace that would weaken
its own replay.

\`\`\`typescript
import { dogwood } from "@intentius/chant-lexicon-cedar";

const { entityRef, traceEvent } = dogwood;

const ALICE = 'Drupe::OAuthUser::"alice"';
const GATEWAY = 'Drupe::Gateway::"gw1"';

const session = {
  scope: { principal: ALICE, resource: GATEWAY },
  context: { input: { user: "alice" } },
} as const;

const injected = (requestId: string) => ({
  callerPrincipal: entityRef(ALICE),
  callerResource: entityRef(GATEWAY),
  requestId,
});

export const trace = [
  traceEvent({ ...session, timestamp: 0, action: 'Drupe::Action::"Login"', record: injected("u1") }),
  traceEvent({ ...session, timestamp: 0, action: 'Drupe::Action::"Login"', kind: "response", record: injected("u1") }),
  traceEvent({ ...session, timestamp: 10, action: 'Drupe::Action::"Read"', record: injected("u2") }),
  traceEvent({ ...session, timestamp: 7200, action: 'Drupe::Action::"Read"', record: injected("u3") }),
];
\`\`\`

\`\`\`
@0 scope(principal: Drupe::OAuthUser::"alice", resource: Drupe::Gateway::"gw1") request_context(input: { user: "alice" }) Drupe::Action::"Login"::request(input: { user: "alice" }, callerPrincipal: Drupe::OAuthUser::"alice", callerResource: Drupe::Gateway::"gw1", requestId: "u1")
\`\`\`

Compare the input to the output: \`input\` was written once, under \`context\`,
and comes out in the \`request_context\` envelope **and** in the logged record.
\`kind\` defaults to \`request\`. Values render in Cedar surface
forms: strings quote themselves, \`entityRef()\` renders a uid bare,
\`decimalValue("1.50")\` keeps a scale a JS number would lose, and a non-integer
\`number\` throws rather than emitting something the parser reads differently.

## The both-bags trap

Each line carries two field bags and they are not the same bag.

\`\`\`
@10 … request_context(input: { user: "alice" }) Drupe::Action::"Read"::request(input: { user: "alice" }, callerPrincipal: …)
      └── the Cedar request is built from this   └── temporal predicates match against this
\`\`\`

\`formerly within 1h Drupe::Action::"Login"::response{ input.user: context.input.user }\`
compares the *past* login's \`input.user\`, out of the logged record, against the
*current* request's \`context.input.user\`, out of the \`request_context\`
envelope. Fill one bag and not the other and nothing errors: the replay exits 0
with a verdict that tested half of what it claims.

So the default is both bags, and the weaker trace takes an explicit opt-out:

| \`bags\` | Where a \`context\` group lands |
|---|---|
| \`"both"\` (default) | \`request_context\` and the logged record |
| \`"record-only"\` | The logged record alone — \`context.*\` is absent from the Cedar request |
| \`"context-only"\` | The envelope alone — no temporal predicate can match the group |

\`record\` is the other half of the input, and it is deliberately separate: the
event schema's own injections (\`callerPrincipal\`, \`callerResource\`,
\`requestId\`, \`sessionId\`) belong to the logged record and are never part of the
Cedar request.

## The action-naming trap

Action names must be fully qualified — \`Drupe::Action::"Read"\`, never \`Read\`. A
short name leaves every temporal predicate unmatched while Cedar still
authorizes. \`traceEvent()\` rejects one at construction, as do \`entityRef()\` and
\`traceEntity()\`.

## Auditing a trace chant did not build

A trace fetched from somewhere else — an AgentCore session history, a \`.log\`
recorded by hand — normalizes into the same \`TraceEvent\` list and takes the
same audit:

\`\`\`typescript
const issues = dogwood.auditTrace(events);
\`\`\`

| Kind | What it means |
|---|---|
| \`single-bag\` | A group is in one bag and not the other, so one side of the check silently misses |
| \`no-request-context\` | A deciding event has no envelope at all, so every \`context.*\` test misses |
| \`empty-record\` | An event logs no fields, so no temporal predicate can match it |
| \`out-of-order\` | A timestamp goes backwards; history accumulates in file order, so a window sees something different |

Every one of those makes a replay *weaker* rather than making it fail, which is
the class a green run hides. \`decisionKinds\` defaults to \`["request"]\` — a
history-only event never becomes a Cedar request, so a missing envelope on one
is not a weakening and is not reported. The truth is whichever kinds the
project's \`.dwschema\` marks \`decision\`, and that file is not visible from the
audit.

\`traceFixture(events)\` runs the same audit and **throws** on any finding,
naming the \`allow\` list that would let it through. A fixture that weakens its
own replay fails at build time instead of producing a green run that proves
nothing.

## Expectations

\`\`\`typescript
export const expectations = [
  { timestamp: 0, verdict: "deny", note: "the login request itself is not permitted" },
  { timestamp: 10, verdict: "allow", determiningRules: [0], note: "the login is ten seconds old" },
  { timestamp: 7200, verdict: "deny", note: "the login is two hours stale" },
];
\`\`\`

Three expectations for four trace lines, and that is the point of writing them
against \`timestamp\` rather than \`index\`: \`Login::response\` is history-only
under the default event schema, so it contributes to the window and produces no
verdict. \`index\` is the position in the *decision* stream, not the trace line
number, and it shifts whenever a trace gains a history-only event.

\`determiningRules\` is the second half of the assertion. A decision that comes
out right for the wrong reason — the correct verdict carried by a different
rule — is drift the verdict alone cannot show.

What \`compareVerdicts\` reports: a verdict that differs from the expectation; a
verdict that matches but was determined by different rules; a decision point an
expectation named that never occurred; a decision point that occurred and
nothing expected. Per-evaluation errors are reported even when the expectation
matched, and — when no expectations were written at all — an errored evaluation
is still a finding, because a provider with no inlined Rhai script would
otherwise replay "clean".

## The trace format

One event per line. Blank lines are skipped, a leading BOM is stripped, and
there is **no comment syntax** — a \`//\` is an ordinary part of a value, so URLs
survive and an attribution header would be parsed as an event and rejected with
"timepoint must start with \`@\`".

\`\`\`
@<timestamp> [scope(...)] [entities(...)] [request_context(...)] <Ns>::Action::"<Name>"::<kind>(<field>: <value>, ...)
\`\`\`

The timestamp is an \`i64\` after \`@\`. The three envelopes are optional and must
appear in that order. Values use Cedar surface forms: entity refs, quoted
strings, integers, decimals like \`1.50\`, booleans, arrays, nested records.

## Reading the run

Human output is one line per decision point:

\`\`\`
@0 (time point 0): DENY
@10 (time point 1): ALLOW  [rules: 0]
@7200 (time point 2): DENY
\`\`\`

JSON gives \`{verdicts: [{index, timestamp, verdict, determining_rules, errors}]}\`.
History-only events produce no line.

**Replay exits 0 even when every verdict is DENY.** A non-zero exit means the
trace or the policy set failed to load, never that a policy denied. The adapter
in \`src/dogwood/cli.ts\` reads the JSON and not the exit code, here as
everywhere; an unrecognised verdict string is read as a deny rather than
dropped, because dropping an entry would shift every later index.

## It needs the binary, and does not pretend otherwise

The Replay phase shells to upstream's CLI. There is no npm package and no wasm
build — see [Validation](../dogwood-validation/) for how chant finds a binary
and how to build one.

Without one the step **fails** and says where chant looked. It does not degrade
to a pass, and an unusable invocation or a fatal (a malformed trace line, an
unparseable policy set) throws rather than reporting zero divergences. A replay
that did not happen is not a replay that found nothing — which is also why
nothing in gating CI executes the binary.

## Next

- [Validation](../dogwood-validation/) — the two verbs that run inside a build,
  and the binary knobs replay shares
- [The Dogwood Dialect](../dogwood/) — what pre-release means for all of this
`;
