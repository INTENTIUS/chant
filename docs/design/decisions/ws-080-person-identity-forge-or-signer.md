---
schema: 1
id: "ws-080"
title: "A person is a forge identity or a signer, and a gate can require a signed approval"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#3163"
  row: "Person-attributed records and gates rest on forge identities or signer keys, not hud's roster"
  revision: null
question: "When a person answers a decision point, reviews a record or approves a gate, the record names them by whatever hud passes, today the signed-in player's roster name. What may a surface pass as that name, how does chant tell a checkable identity from a roster name, how does a workspace refuse the second, and how does a gate require a signed approval from a declared class, without chant authenticating anyone and without breaking hud's shipped `--actor <roster name>` flow?"
options:
  - id: "a"
    label: "principal strings in three forms, an identity block in the declaration read at base, and an ssh seal on the gate approval"
    how: "A person is named by a forge identity (github:<login>, gitlab:<login>, or <forge>@<host>:<login>), by a principal .chant/allowed_signers lists at base, or, for a non-person, by a principal holding the agent, runner or service role at base. The surface that signed the person in maps its session to one of these and passes it as --by or --actor; chant records it as given. The signers file and the role grants name people by the same string, so github:alice is one person in a record, the key list and a principal class (ws-079). The declaration gains identity: attribution \"identified\" refuses any other name on records new, amend and review, points answer and chant approve with principal-unidentified; gates.<gate> (with an optional class) counts only approvals of that gate sealed with chant approve --sign by a key the signers file at base lists for the approver, from the class when one is named. The seal is an ssh signature in a chant-gate namespace over the op, gate, environment, plan digest, approver and time. A run, workspace status and chant approve all apply the rule, read from the declaration and trust policy at base. Without the block nothing changes."
    tradeoff: "No new trust root: the forge identity is only a naming convention, and the attestation is the ssh seal and signers file chant already verifies for verdicts and records (#2687, #2688). A forge identity alone is still the surface's word, so a workspace that wants proof names the gate in identity.gates. The cost is that a surface which signs for people must hold or reach a key the signers file lists for each one, and a renamed forge login needs a signers and role edit, which is itself a protected write."
  - id: "b"
    label: "chant verifies a forge token"
    how: "The surface passes the person's OAuth token; chant calls the forge's user API, checks the login and records it as verified."
    tradeoff: "A forge-verified name without any key setup. chant would then authenticate a person and reach the network on every write, both of which ws-052 and the read-only, offline write paths rule out, and the record would carry nothing a later reader can re-check: the token is gone once used."
  - id: "c"
    label: "the rule on the Op's gate approval block"
    how: "A gate step's approval block (#2508) gains signed: { class }, carried on the pending fact like quorum."
    tradeoff: "It sits beside quorum. But the block is part of the change being run, so a branch can drop the requirement for its own run, component gates (the ones hud's work board approves) have no approval block, and a class is only known at base."
  - id: "d"
    label: "refuse roster names everywhere"
    how: "chant approve and the record writers refuse any principal that is not a forge identity or a signer, with no opt-in."
    tradeoff: "One rule for every workspace. It breaks hud's shipped approvals (#732, #733) and every README that teaches --actor you, in workspaces that never asked for identities."
choice:
  option: "a"
  reason: "ws-052 keeps signing people in with hud and its peers, and the seal and signers file at base are already how chant attests a person (#2547, #2687, #2688), so the surface's part is a mapping and chant's part is the rule and the check. Reading the rule from the declaration at base, as writeScope is read (ws-067), keeps a change from loosening its own gate and covers every gate by name, Op or component. An opt-in attribution rule keeps hud's roster approvals working where a workspace hasn't asked for more, which is the owner's call for the burn-down (D10), and lets a workspace that has asked refuse them. Classes come from ws-079's classesOf, so an operator class a plugin supplies is the role grant at base, and a class nothing supplies lets nothing through."
rejected:
  - option: "b"
    why: "chant would authenticate a person and reach the network on a write, and the record would hold nothing re-checkable."
  - option: "c"
    why: "The rule would be in the change it judges, and component gates have no approval block."
  - option: "d"
    why: "It breaks hud's shipped flow in workspaces that never opted in."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3163, person-attributed records and gates rest on forge identities or signer keys"
    url: "https://github.com/INTENTIUS/chant/issues/3163"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#738, approvals and verdicts rest on a forge identity or signer key"
    url: "https://github.com/arugula-salad/hud/issues/738"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#732, approve any pending gate from the work board"
    url: "https://github.com/arugula-salad/hud/issues/732"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#733, a trusted follower names who answered or approved"
    url: "https://github.com/arugula-salad/hud/issues/733"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-079, principal classes from plugins"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-079-principal-classes-from-plugins.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-052, the chant and hud boundary"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-052-chant-hud-boundary.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3163"
  - "arugula-salad/hud#738"
  - "ws-052"
  - "ws-079"
  - "path:packages/core/src/workspace/identity.ts"
  - "path:packages/core/src/workspace/trust/seal.ts"
  - "path:packages/core/src/op/gate.ts"
---

# A person is a forge identity or a signer, and a gate can require a signed approval

The forms a person is named by and the `identity` block are described in [Workspace Declaration](https://intentius.io/chant/reference/workspace-declaration/#identity), and `chant approve --sign` in [Operator](https://intentius.io/chant/cli/operator/).
