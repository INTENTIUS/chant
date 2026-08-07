# aws-warden

Keep your AWS organization in a declared state — OUs, SCPs, and audit sinks;
stateless, drift-correcting reconcile from the management account. The cloud
member of chant's warden family (epic intentius/chant#787), on the same
reconcile seam and guarantees as github/gitlab/forgejo-warden: one binary +
one config file, no state file, selective-by-omission, ownership-gated
deletes, dry-run by default.

## Install

```sh
npx @intentius/aws-warden reconcile --config governance.yml --mode dry-run
```

Auth is standard AWS credentials from the environment (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` for STS, region from
`AWS_REGION`), run from the organization's management account.
`AWS_ENDPOINT_URL` points at an emulator.

## Config

The config is the `AwsGovernanceConfig` tree — author it by hand or emit it
from typed TS with `landingZoneConfig()` in `@intentius/chant-lexicon-aws`
(#791):

```yaml
organization:
  scps: [deny-leave-organization]
ous:
  Security:
    scps: [deny-audit-tamper]
  Workloads:
    children:
      Prod:
        accounts:
          - { name: checkout, email: aws+checkout@acme.dev }
scps:
  deny-leave-organization:
    description: root guard
    document:
      Version: "2012-10-17"
      Statement:
        - { Effect: Deny, Action: "organizations:LeaveOrganization", Resource: "*" }
  deny-audit-tamper:
    document:
      Version: "2012-10-17"
      Statement:
        - Effect: Deny
          Action: [ "cloudtrail:StopLogging", "cloudtrail:DeleteTrail" ]
          Resource: "*"
auditSinks:
  cloudtrail: { bucket: acme-org-audit, multiRegion: true }
```

## Cycles

| Cycle | Verb | Reconciles |
| --- | --- | --- |
| `org-units` | `org-unit` | The OU tree and account placements. OU create/delete (deletes gated on the `managed-by: aws-warden` tag); accounts move via `MoveAccount`; account creation/closure is deliberately manual and surfaces in the plan with instructions. |
| `scps` | `policy-guardrail` | SCP documents, descriptions, attachments. Field-level drift; AWS-managed policies untouched; deletes ownership-gated. |
| `audit-trail` | `audit-sink` | The organization CloudTrail (bucket, multi-region). Never deleted. |

The `identity-assignment` cycle (SSO/IAM + the break-glass-admin guardrail)
is the tracked follow-up on intentius/chant#792.

## Guardrails

On top of the shared removal-delta cap:

- **root-SCP floor** — a plan that would leave the organization root with no
  SCP attached is blocked.
- **OU deletion cap** — more than 2 OU deletes in one run is blocked
  (a hierarchy typo must not cascade).

`--allow-guardrail-override` applies anyway, deliberately.

## Scope honesty

Cloud org hierarchy drifts slower than SCM org state: expect this warden's
value to lean toward posture evidence and brownfield gap-fill (the #793 audit
tier) rather than constant drift correction. Landing-zone *creation* belongs
to Control Tower and the `GovernanceFoundation` bootstrap composites in the
aws lexicon.

## e2e

`e2e/` runs the reconcile loop against a floci (AWS emulator) endpoint —
gated, self-skipping, hermetic (`.github/workflows/warden-aws-e2e.yml`,
nightly). The current floci build has no organizations service
(test/floci-gaps.md entry 5), so the suite self-skips green; the in-memory
convergence suite (`src/reconcile/convergence.test.ts`) carries the same
dry-run → apply → empty-plan → drift-redetected assertions in the default
test run meanwhile.
