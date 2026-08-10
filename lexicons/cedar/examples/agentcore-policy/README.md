# agentcore-policy

A Bedrock AgentCore gateway policy set: one plain-Cedar wall and two temporal
rules, embedded through the typed `Definition` seam and staged with
`EnforcementMode`.

```
npx chant build src
```

`src/policies.ts` declares one `Policy`, two `TemporalPolicy` entities, an event
schema and the macro library the temporal rules call. `chant build` writes:

| file | what reads it |
| --- | --- |
| `policies.cedar` | any Cedar evaluator |
| `policies.cedar.json` | the JSON policy format |
| `policies.dw` | `dogwood validate` / `dogwood replay`, and the AgentCore policy engine |
| `events.dwschema` | the service half of the schema |

The `gatewayPolicies` export in the same file renders the same declarations into
the props `AWS::BedrockAgentCore::Policy` takes, so the statement AWS evaluates
and the statement on disk come out of one renderer and cannot drift.

## The two arms

`AWS::BedrockAgentCore::Policy`'s `Definition` is a `oneOf` over two arms:

```jsonc
{ "Cedar":  { "Statement": "@id(\"deny-unauthenticated-write\")\nforbid (\n  ...\n);" } }
{ "Policy": { "Statement": "@id(\"write-needs-approval\")\npermit (\n  ...\n)\nwhen temporal {\n    formerly within 1h ...\n}\n;" } }
```

`Cedar` is plain Cedar. `Policy` is the language-agnostic arm, and it is what
makes AgentCore the deployment target for the dogwood dialect: a `.dw` policy is
a Cedar policy with `when temporal { … }` clauses, which the Cedar parser at the
other end would reject.

`agentCorePolicyDefinition(name, policy)` picks the arm from the policy — a
`Dogwood::TemporalPolicy`, or any props carrying a temporal clause, goes to
`Policy`; plain Cedar goes to `Cedar`. Getting that wrong by hand is a
deploy-time parse error whose message is about the policy text rather than about
the arm.

There is no template arm. `AWS::VerifiedPermissions::Policy` has
`TemplateLinked`; AgentCore does not, so a statement carrying a `?principal` or
`?resource` slot is refused here, at authoring time, rather than at deploy time.

## Staging with EnforcementMode

`EnforcementMode` takes `LOG_ONLY` or `ACTIVE`, and AWS's own schema says what
the first one buys:

> LOG_ONLY policies are still evaluated but their decisions are observed only,
> allowing customers to validate a policy against real traffic before promoting
> it.

That is observe-before-enforce in the substrate, per policy. It matters most for
a temporal rule: whether `formerly within 1h …` fires depends on traffic nobody
has replayed yet, so the source alone will not tell you what promoting it would
have denied.

```ts
...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only")
```

Promotion is `"log-only"` → `"enforce"` on that line. The authoring vocabulary
is deliberately not AWS's: `ACTIVE` reads as "not disabled", but `LOG_ONLY` is
active too — it is evaluated on every request. `enforcementMode()` is the one
place the translation happens.

## The event schema is not optional

`AWS::BedrockAgentCore::Policy` carries a statement and nothing else. The event
schema — which event kinds exist, what they carry, what is pinned to the
deciding request — has no property to live in, so it is registered with the
engine separately. A build that embeds temporal text and emits no `.dwschema`
has shipped half a policy: the statement deploys, every temporal predicate
matches nothing, and the rule stops doing its job without failing. `DWDC013`
reports that.

This example declares `gatewayEvents` so the schema ships as a reviewable
artifact beside the policies.

## No dependency on the aws lexicon

Same rule as `avp-embedding`, for the same reason: Cedar is vendor-neutral and
AgentCore is one evaluator among several, so a cedar → aws dependency would
invert that and make the cedar lexicon unbuildable without the aws one. The seam
is the data shape, not an import, and this example uses a plain-object stand-in
with the generated class's own prop names.

The stand-in is not a shortcut around a missing capability — it is what the
example harness allows. The shipped cedar examples build against the cedar
serializer alone, so an `AWS::*` entity declared in this tree would have no
serializer to emit it.
