---
schema: 1
id: "ws-069"
title: "Signer rotation, and where runner keys come from"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2553"
  row: "Rotation is verified from history, and revocation is by position in history; Runner keys live with a service or CI identity"
  revision: null
question: "How does a new signer set prove the old one admitted it, how is a commit judged once keys have been removed, and what does a verifier trust for runner evidence?"
options:
  - id: "a"
    label: "a TUF-style rotation file beside the signers file, history judged by first-parent position, runner keys in .chant/trust.json"
    how: "`<signers>.rotation.json` holds the version, the previous set's digest, the new threshold and ssh signatures in the chant-signers namespace by a threshold of distinct signers of the set before. The verifier walks the base's first-parent line, and judges each commit by the version in effect just before the first-parent commit that brought it in. Runner evidence is a DSSE envelope over an in-toto statement, signed with an Ed25519 key that `.chant/trust.json` at base lists under `runners` with a principal and a class (runner or service). A key or principal the signers file lists is refused as a runner."
    tradeoff: "Everything is in the repository and read at base, so it verifies offline with nothing but git, ssh-keygen and node. Keys are long-lived, so a runner key has to be kept in a CI secret store and rotated by a protected write."
  - id: "b"
    label: "runner keys as lines in the signers file, restricted by namespaces"
    how: "List CI keys in allowed_signers with `namespaces=\"chant-evidence\"` and sign evidence with `ssh-keygen -Y sign`."
    tradeoff: "One file of keys, but a runner key would then be a signer that a namespace typo turns into a commit signer, and the rule that a person's key never signs evidence could not be told apart from the file's own lines."
  - id: "c"
    label: "keyless signing through an OIDC identity and a transparency log"
    how: "Sigstore-style: the CI job's OIDC token gets a short-lived certificate, and evidence is verified against a certificate authority and a log."
    tradeoff: "No long-lived key to keep, but verifying needs the CA roots and the log, which breaks the offline rule, and the trust root would be a service chant does not run."
  - id: "d"
    label: "revocation by date"
    how: "Keep `valid-after` and `valid-before` on signer lines and compare them with commit dates."
    tradeoff: "Familiar from ssh, but whoever makes a commit sets its date, so a revoked key can backdate its way in."
choice:
  option: "a"
  reason: "The policy stays in the two files #2547 already reads at base, and a change to either is a protected write, so trust roots come only from the policy and never from the change. Signatures count once per key and once per principal, a threshold above the new set's distinct signers is refused so a set can't freeze itself, and the version and previous digest stop replay and rollback. Position on the first-parent line is something a committer can't set, unlike a date. Runner keys sit apart from signer keys so a person's key can never make evidence and a runner key can never sign a commit. Each refusal has a code in the read contract's closed list, carried by signers.schema.json, evidence.schema.json and the rotation field of verify."
rejected:
  - option: "b"
    why: "It mixes machine keys into the file that names people, and the person-versus-runner rule would rest on a namespace option."
  - option: "c"
    why: "It needs network roots, and the issue asks for offline verification."
  - option: "d"
    why: "Dates are chosen by the committer. #2547 already refuses timed signer lines for this reason."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2553, signer rotation and DSSE runner evidence, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2553"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5 and the threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "TUF specification, root rotation"
    url: "https://theupdateframework.github.io/specification/latest/#key-management-and-migration"
    as_of: "2026-09-30T00:00:00Z"
  - title: "DSSE envelope, v1"
    url: "https://github.com/secure-systems-lab/dsse/blob/master/envelope.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2553"
---

# Signer rotation, and where runner keys come from

Record seals are still checked against the latest set at base rather than by position, so a rotation that removes a key stops that key's older seals from counting. That is #3077.

A statement for an agent run (harness, model, provider and the run record's hash) is not part of this record. It needs the run record of #3033, and is left to epic #3037.
