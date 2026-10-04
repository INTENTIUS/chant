---
schema: 1
id: "ws-090"
title: "The agent-run statement"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#3192"
  row: "agent-run statement signed by a runner or steward key (DSSE)"
  revision: null
question: "How does a runner or steward vouch for an agent run, so that a reader can tell a run it vouched for from a run whose writer only reported itself: what does the signed statement assert, which keys may sign it, where is it kept, and how do runs, runs verify and workspace verify use it?"
options:
  - id: "a"
    label: "an in-toto statement over the run record's hash in a DSSE envelope, signed by a runner key trust.json lists, kept as a statement line in the run's ledger file"
    how: "The statement's subjects are the commits the run made, each by gitCommit with its patch-id as an annotation; the predicate (https://intentius.io/chant/agent-run/v1) holds the signer's principal, the run id and the SHA-256 of the canonical JSON of its start and end lines, and the unit, harness, model, provider and the principal the run worked for. It is signed with an Ed25519 key .chant/trust.json lists at base under runners, the keys runner evidence uses (ws-069), class runner or service; a key the signers file lists is refused. chant workspace runs sign <id> --key signs here; runs statement <id> --signer prints the payload for a signer that keeps its key elsewhere, and runs sign <id> --envelope checks and stores what it returns. The envelope is appended to _agent-runs/<id>.jsonl on chant/lifecycle as a statement line after the end. runs --json gives each run its record hash, its statements and an attestation judged against the keys at base; runs verify reports and fails only with --require signed; workspace verify counts a commit a signed run made as attested by the agent-run attestor, and --require attested-runs asks that of every commit a run made."
    tradeoff: "One trust root for machines, the runner keys at base, so a key is added and revoked by the same protected write as evidence keys, and removing it makes what it signed read as untrusted from then on. Verification is offline and repeated on every read, never trusted from the write. Readers that run an older chant count the new line as malformed until they upgrade. The trailer that marks a commit as a run's is still the committer's word, so attested-runs covers commits that name a run, and a run that hides its trailer is caught only by its own end's list."
  - id: "b"
    label: "the steward signs the commits themselves with an ssh key in allowed_signers"
    how: "A steward or lobby key is listed in .chant/allowed_signers with namespaces=\"git\" and signs each commit the run makes, as a person does."
    tradeoff: "No new format, and workspace verify already checks it. ws-069 rejected machine keys in the file that names people, the signature says nothing about the run, its model or its cost, and studio-034 keeps the key in the lobby, which never holds the box's commits to sign."
  - id: "c"
    label: "a separate statements directory or record kind"
    how: "Statements kept in _agent-run-statements/ on chant/lifecycle, or as records in the working tree."
    tradeoff: "Older readers would not see a new line in the run file, but a statement would live apart from the record it signs, and a record kind puts a never-revised fact through review, which ws-068 and ws-076 keep ledgers out of."
  - id: "d"
    label: "sign the run file's bytes"
    how: "The statement's digest is the SHA-256 of _agent-runs/<id>.jsonl as stored."
    tradeoff: "Simple to compute, but storing the statement in the file changes the bytes it signed, and a second signer would sign a different digest."
choice:
  option: "a"
  reason: "studio-033 c and studio-034 a have the lobby sign with one key it keeps from Infisical, which is one entry in .chant/trust.json's runners rather than one per plant, and studio-036 b asks the statement to carry the run record's hash and the unit plus the model and harness, with the commits and patch-ids of ws-076 as subjects. ws-069 already put machine keys in trust.json, refused a person's key there and made DSSE over in-toto the format, so a run statement reuses the envelope, the keys and the refusal codes of runner evidence. Hashing the canonical start and end lines leaves the file free to gain statement lines, so several signers can sign one record. Keeping the statement in the run's own ledger file follows ws-074 and ws-076: it is a fact about the run, written once, beside the record it signs. studio-035 d wants a report before a requirement, so runs verify and workspace verify report without failing, and --require signed and --require attested-runs are the switch for when the lobby signer runs."
rejected:
  - option: "b"
    why: "ws-069 keeps machine keys out of the signers file, and a commit signature does not carry the run's model, harness or record."
  - option: "c"
    why: "It separates the statement from the record it signs, and a record kind puts a ledger fact through review."
  - option: "d"
    why: "Storing the statement would change the bytes it signed."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3192, agent-run statement signed by a runner or steward key (DSSE)"
    url: "https://github.com/INTENTIUS/chant/issues/3192"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#2553, signer rotation and DSSE runner evidence, which handed the agent-run statement on"
    url: "https://github.com/INTENTIUS/chant/issues/2553"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-069, signer rotation, and where runner keys come from"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-069-signer-rotation-runner-keys.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-076, the agent run record"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-076-the-agent-run-record.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "studio-033, the signing identity for agent runs"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/decisions/studio-033-the-signing-identity-for-agent-runs.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "studio-034, where the agent-run signing key is kept"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/decisions/studio-034-where-the-agent-run-signing-key-is-kept.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "studio-035, whether studio repos require attested agent commits"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/decisions/studio-035-whether-studio-repos-require-attested-agent-comm.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "studio-036, what an agent run's statement asserts"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/decisions/studio-036-what-an-agent-run-s-statement-asserts.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#286, lobby metering wants a signed run statement it can trust"
    url: "https://github.com/arugula-salad/studio/issues/286"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3192"
  - "arugula-salad/studio#281"
  - "arugula-salad/studio#286"
  - "ws-069"
  - "ws-076"
  - "path:packages/core/src/workspace/trust/run-statement.ts"
  - "path:packages/core/src/workspace/runs.ts"
---

# The agent-run statement

`chant workspace runs sign`, `runs statement` and `runs verify` are described in [chant workspace runs](https://intentius.io/chant/cli/workspace-runs/#signed-statements), and `--require attested-runs` in [chant workspace verify](https://intentius.io/chant/cli/workspace-verify/#what-passes).
