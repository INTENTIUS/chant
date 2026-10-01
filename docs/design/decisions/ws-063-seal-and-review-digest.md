---
schema: 1
id: "ws-063"
title: "Seal and review digest"
state: "decided"
area: "D4"
source:
  issue: "INTENTIUS/chant#2546"
  row: "Seal and review digest"
  revision: null
question: "ws-003 says a record's seal covers the whole file, and a review verdict names a digest that leaves out the reviews, the author seal and the state so that adding a verdict or ratifying keeps earlier verdicts counting. Is that digest the seal, or are they two hashes, and what does each cover?"
options:
  - id: "a"
    label: "two hashes"
    how: "The review digest stays as shipped: the SHA-256 of the file's text with LF line endings and without the reviews block, the top-level seal block, the state line of a kind with a ratified state, and the seal field. The record seal is separate: sha256: and the SHA-256 of the RFC 8785 (JCS) form of the whole record, the front matter as core and the text below it as body, with only the seal field left out. A kind names the seal field in seal.field, closed_digest for decisions, and records amend, new and close write it when a record enters a closed state. records checks it on read as record-seal-mismatch, or session-seal-mismatch for a session."
    tradeoff: "Every existing digest keeps its value, so no verdict stops counting, and ws-003 holds as written. Readers have two hashes to tell apart, and the seal exists only on closed records."
  - id: "b"
    label: "the digest is the seal"
    how: "Amend ws-003 to the shipped scope: the seal is the review digest, and the reviews, the author seal and the state stay outside it."
    tradeoff: "One hash. The verdicts and the state of a closed record, the parts a reader checks first, would be text no seal covers, which ws-003 rejected for in-file regions."
  - id: "c"
    label: "one whole-file hash for both"
    how: "The review digest becomes the whole-file JCS hash, and a verdict names it."
    tradeoff: "One hash that covers everything. Each new verdict, and the move to ratified, changes the hash the earlier verdicts named, so no quorum could ever be met, and every digest on disk moves."
choice:
  option: "a"
  reason: "A verdict and a seal answer different questions. A verdict binds a reviewer to the text they judged, and that text must stay put while other verdicts and the ratification are added (#2672, #2873, #2688). A seal says the record has not changed since it closed, and that has to include the verdicts and the state. Two hashes keep every digest in the repository, the reference workspace and the tests at its value, and keep ws-003's whole-file scope for the seal. JCS over the parsed core follows #2524 D4, so a record written another way seals the same. The digest leaves the seal field out, so writing the seal at the close moves no digest."
rejected:
  - option: "b"
    why: "It leaves the verdicts and the state of a closed record unsealed, the in-file region ws-003 ruled out."
  - option: "c"
    why: "Adding the second verdict would void the first, and ratifying would void them all."
supersedes: []
evidence:
  - title: "ws-003, Seal scope"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-003-seal-scope.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D4. Records"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d4-records"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2546, records, seals and the spec query, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2546"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2873, ratifying keeps the verdicts counting"
    url: "https://github.com/INTENTIUS/chant/issues/2873"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2546"
  - "INTENTIUS/chant#2555"
  - "ws-003"
---

# Seal and review digest

| Hash | Covers | Leaves out | Written |
|---|---|---|---|
| review digest | the file's text, LF line endings | the reviews block, the top-level `seal` block, the state line of a kind with a ratified state, the seal field | never; `records --json` prints it, and a verdict names it |
| record seal | the JCS form of the front matter and the body | the seal field only | when the record enters a closed state, into the seal field |

Without an attestor, seals detect accidental edits only: anyone can recompute one. A closed session sealed by the earlier text rule reads as `session-seal-mismatch` and is sealed again by hand.
