---
schema: 1
id: "ws-066"
title: "Versioned plan digest"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2547"
  row: "A JCS plan digest carries a versioned prefix so pending gates still match"
  revision: null
question: "#2524 says a JCS plan digest gets a versioned prefix so pending gates still match. What is the prefix, what does the digest cover, and how do gates recorded under the bare sha256: prefix keep matching?"
options:
  - id: "a"
    label: "jcs1-sha256: over the bytes chant already hashes, and both prefixes read"
    how: "computePlanDigest writes jcs1-sha256: and the hex of the SHA-256 of the canonical JSON of { kind, subject }. canonicalJson already sorts keys by UTF-16 code unit and writes numbers as ECMAScript does, which is RFC 8785, so the hex does not move. isPlanDigest accepts either prefix, and samePlanDigest treats two plan digests as one when their hex is equal, which every comparison of a gate record with a plan goes through."
    tradeoff: "Pending gates and approvals recorded as sha256:<hex> still match the same plan, and nothing is rewritten. The printed digest and the approve command change their prefix, which is a level-0 change on the exception list."
  - id: "b"
    label: "a new input form with its own hex"
    how: "Change what is hashed, for example the whole plan object, and give it a new prefix."
    tradeoff: "A pending gate could never match without recomputing the old form beside the new, and the digest would cover more than the change set, which #2300 chose not to."
  - id: "c"
    label: "keep sha256: and say nothing"
    how: "Leave the prefix as is."
    tradeoff: "Nothing changes for anyone, and the digest still does not say how it was made, so a later change to the input form could not be told apart from this one."
choice:
  option: "a"
  reason: "The input form is already the one #2524 names, so the work is to say so in the digest and keep old records readable. Comparing by hex rather than by string keeps a pending gate or an approval recorded before this change valid, the way #2514 kept old digests readable. Writing the new prefix means the next form can be told from this one."
rejected:
  - option: "b"
    why: "It breaks every pending gate, which the issue rules out."
  - option: "c"
    why: "It leaves the digest unversioned."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D5: builds on the shipped plan digest (#2300)"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2514, real SHA-256 and legacy digests"
    url: "https://github.com/INTENTIUS/chant/issues/2514"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2547, attestors, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2547"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2547"
  - "INTENTIUS/chant#2525"
---

# Versioned plan digest

| Where | Before | Now |
|---|---|---|
| `computePlanDigest` output, pending facts, `chant approve --plan`, the `plan:` line of a gated run | `sha256:<hex>` | `jcs1-sha256:<hex>` |
| a gate record already in a ledger, or a `--plan` typed from an old copy | `sha256:<hex>` | still read, and matches the plan with the same hex |

Release plans and build digests keep `sha256:`: they are not plan digests from `computePlanDigest`, and nothing about them changes.
