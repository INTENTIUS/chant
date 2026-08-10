---
skill: chant-cedar-meta-policy
description: Organizational policy over Cedar policy sets — the bare-permit wall, forbid conventions, and env-aware severity
user-invocable: true
---

# Policy About Policy

## The ruling this sits under

Cedar is a target, never chant's gate. There is no `cedarGate()` and there will
not be one: organizational policy in chant is TypeScript post-synth checks, and
a second policy engine would duplicate the lint engine and break "TypeScript is
the one language."

So the rules below are ordinary `PostSynthCheck`s and lint rules under the `CED`
prefix. They read the emitted policy set the way any other check reads emitted
YAML. Cedar's own validator runs beside them, in-process, through
`@cedar-policy/cedar-wasm` — no CLI on PATH, no Docker.

## The bare-permit wall

```cedar
permit (principal, action, resource);
```

Every scope position unconstrained, no `when`, no `unless`. It grants every
principal every action on every resource. It is legal Cedar, it validates
clean, and it is the single most damaging line a policy set can contain.

The rule is **env-aware, not absolute**:

| Environment | Verdict |
|---|---|
| dev / local | warn — a scratch policy set during development is a normal state |
| staging | warn, and expect it fixed before promotion |
| **prod** | **fail the build** |

Env-aware because an absolute rule gets suppressed the first time it fires
during development, and a suppressed rule protects nothing. Failing only where
the blast radius is real keeps the wall credible.

A permit with any of the following is not bare and does not trip the wall:

- a constrained scope position (`is`, `in`, `==`) on principal, action, or
  resource, or
- at least one `when` or `unless` clause.

## Schema-absent references

A policy naming an entity type or action the schema does not declare fails
**everywhere** — dev included. There is no environment where that is intended.
Two distinct failure modes hide behind it:

1. **The typo.** `App::Documnt`. With generated classes this is a compile error
   before any check runs, which is the point of the codegen. It survives only in
   hand-written expression strings inside `when`/`unless`.
2. **The silent no-op.** A scope naming an entity type outside the schema
   *parses*, and `getValidRequestEnvsPolicy` answers "success, nothing" — an
   empty request envelope. The policy is well-formed, deployed, and can never
   fire. `cedar:coverage` reports these under `inert`.

## Forbid conventions

Cedar is default-deny, so a `forbid` is never about the absence of a grant. It
is about the presence of a bad one: a forbid beats every permit in the set
unconditionally, which makes it the only construct that survives a later, wider
grant somebody adds next quarter.

Three conventions follow:

**Every forbid carries a guard.** An unguarded `forbid (principal, action,
resource)` denies everything and no permit can lift it — the policy set
authorizes nothing. `DenyByDefaultSet` throws on an empty `when` for this
reason.

**A forbid and the permits it governs ship together.** Separated, the forbid
gets deleted during a refactor and the permits keep working, wider than anyone
intended. `DenyByDefaultSet({ policies, when })` returns both from one call.

**Sensitive resources get an explicit floor, not just an absent permit.**
"Nobody wrote a permit for it" and "a forbid says no" look identical at
evaluation time and completely different in review. `cedar:coverage`'s
`forbidOnly` list is how you find declarations that have a floor; its
`uncovered` list is how you find the ones relying on absence.

## Cross-domain checks

This is the thing no Cedar tool can express, because Cedar only ever sees
policies. In a chant build, policies and the infrastructure they govern are in
one entity graph, so a post-synth check can span both:

- an entity id in a policy references an actual resource declaration
- every declared bucket is covered by at least one `forbid`
- no schema action lacks any policy

These are ordinary post-synth checks. They are the differentiator, and they only
work because the policy set and the estate are built together.

## Severity, by environment

| Finding | dev | staging | prod |
|---|---|---|---|
| Bare permit | warn | warn | fail |
| Entity type or action absent from schema | fail | fail | fail |
| Unguarded forbid | fail | fail | fail |
| Policy with an empty request envelope (inert) | warn | warn | fail |
| Schema action no policy covers | info | warn | warn |
| Entity type reachable only from a forbid | info | info | info |

The last row is deliberately never a failure. A resource nothing grants access
to is frequently correct.

## Where these live

Post-synth checks and their catalog entries are **INTENTIUS/chant#1651**'s
scope. This skill describes the conventions the checks encode; if you are
writing a check, put it in `src/lint/post-synth/` with a `CED` id and an
`auditCatalog()` entry, not in a policy file.
