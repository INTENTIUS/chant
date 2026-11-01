---
schema: 1
id: "ws-109"
title: "A gate approval signed outside chant, with an ssh key or a passkey"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#4646"
  row: "approve: accept a signature made outside chant (device keys, passkeys) for signed-only gates"
  revision: null
question: "A gate under identity.gates counts only an approval sealed with chant approve --sign, which needs the key on the machine running chant. A platform that collects the approval elsewhere, such as a person approving on a phone with a passkey, can only relay it unsigned. How does chant take a signature made somewhere else over the same approval, check it against keys a workspace lists, and keep it on the ledger so anyone can check it again?"
options:
  - id: "a"
    label: "print the existing statement, take an ssh signature or a WebAuthn assertion over it, and list passkeys in .chant/trust.json"
    how: "chant approve --statement runs the approval's checks, records nothing, and prints gateSealPayload's bytes for the gate as a chant-gate-statement/v1 document with the time fixed, the SHA-256 digest and the WebAuthn challenge (base64url of that digest). chant approve --signature <file> --at <time> takes either an armored ssh signature in the chant-gate namespace, checked against the signers file as --sign's seal is, or a WebAuthn assertion, checked against a passkey listed under passkeys in .chant/trust.json at base (principal, credential id, SPKI public key, rpId, origins) per WebAuthn level 2: type webauthn.get, the statement's challenge, an allowed origin, the rpIdHash, the UP and UV flags and the signature over authenticatorData and the client data's hash. A passkey's seal is kind webauthn and keeps the assertion, so the one check (checkGateSignature) that chant approve, the identity.gates rule, a sealed gate, gate-decision and checkGateSeal share reads it again from the ledger. The relay may add one line of its own with --binding <text> on both calls (#4697), such as its deploy id and an expiry: the statement signs it last as binding <text>, the seal is version 3, the resolution line keeps it as binding, and chant checks only that it is one printable line of at most 512 UTF-8 bytes."
    tradeoff: "The statement is the one --sign already signs, so an ssh seal made elsewhere is the same seal and old ledgers don't change. The passkey list is policy at base like the signers file, and changing it is a protected write. The signature counter is not checked, since a ledger line can't know the authenticator's last count, so a cloned authenticator isn't caught here. An older chant reads a trust.json with passkeys as invalid and turns attestation off, which fails closed. A binding is checked as part of the signature and never read, so whether the deploy id matches or the expiry has passed is the platform's to check; an older chant leaves the binding line out and counts no version 3 seal, which also fails closed."
  - id: "b"
    label: "a new statement format for signatures made elsewhere"
    how: "Define a JSON statement (op, gate, plan digest, actor, time) canonicalised with JCS, signed by whatever key, beside the ssh seal's LF-joined lines."
    tradeoff: "A self-describing statement, but two statements for one approval, two verifiers to keep in step, and a gate would count seals over either."
  - id: "c"
    label: "passkeys as lines in the signers file"
    how: "Extend allowed_signers with a webauthn key type and options for the rpId and origins."
    tradeoff: "One key list, but ssh-keygen and git read that file, and a line they don't understand would break git log --show-signature and every older chant's parser."
  - id: "d"
    label: "the platform vouches"
    how: "Keep relaying unsigned and let a signed-only gate trust a relay principal the role grants name."
    tradeoff: "No new key handling, but the gate would rest on the platform's word, which is what identity.gates exists to avoid (ws-080)."
choice:
  option: "a"
  reason: "It keeps one statement and one check for every way an approval is signed, so a seal made on a phone is judged where and as an ssh seal is, offline and at base. The passkey's public key, rpId and origins are what a relying party checks an assertion against, and keeping them in trust.json beside runners keeps the signers file readable by ssh-keygen and git."
rejected:
  - option: "b"
    why: "Two statements for one approval double what a gate must verify and what can drift."
  - option: "c"
    why: "The signers file must stay ssh-keygen's format."
  - option: "d"
    why: "A signed-only gate must not rest on the relay's word."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4646, approve: accept a signature made outside chant"
    url: "https://github.com/INTENTIUS/chant/issues/4646"
    as_of: "2026-11-01T00:00:00Z"
  - title: "INTENTIUS/chant#4697, gate statement: an optional binding line from the relay"
    url: "https://github.com/INTENTIUS/chant/issues/4697"
    as_of: "2026-11-01T00:00:00Z"
  - title: "arugula-salad/arugula#1988, Arugula on chant"
    url: "https://github.com/arugula-salad/arugula/issues/1988"
    as_of: "2026-11-01T00:00:00Z"
  - title: "Web Authentication level 2, verifying an authentication assertion"
    url: "https://www.w3.org/TR/webauthn-2/#sctn-verifying-assertion"
    as_of: "2026-11-01T00:00:00Z"
  - title: "ws-080, a person is a forge identity or a signer"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-080-person-identity-forge-or-signer.md"
    as_of: "2026-11-01T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-11-01"
reviews: []
constrains:
  - "INTENTIUS/chant#4646"
  - "INTENTIUS/chant#4697"
  - "ws-080"
  - "path:packages/core/src/lifecycle/gate-seal.ts"
  - "path:packages/core/src/lifecycle/gate-webauthn.ts"
  - "path:packages/core/src/lifecycle/gate-statement.ts"
---

# A gate approval signed outside chant, with an ssh key or a passkey

The statement, the `passkeys` entries and the checks are described in [Workspace Declaration](https://intentius.io/chant/reference/workspace-declaration/#approvals-signed-outside-chant), and the flags in [Operator](https://intentius.io/chant/cli/operator/).
