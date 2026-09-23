---
schema: 1
id: "ws-004"
title: "Hosted return"
state: "decided"
area: "D10"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Hosted return"
  revision: null
question: "When a workspace returns to a hosted service, how does the service come to trust keys it never saw?"
options:
  - id: "a"
    label: "admin admits signers"
    how: "A hosted admin signs an admission naming the new signers, with the signer-change chain shown as evidence. Original signatures stay in place."
    tradeoff: "Authorship survives the round trip. Anything signed by the new keys stays unverifiable until an admin acts."
  - id: "b"
    label: "service re-signs"
    how: "The service attests again, under its own key, everything added outside it."
    tradeoff: "Verification passes at once. The service's identity stands in for the original authors."
  - id: "c"
    label: "adopt only"
    how: "Work done outside the service is admitted only through adoption, the path D5 uses for older history."
    tradeoff: "No new mechanism is needed. That work shows as `adopted` and never as `attested`."
  - id: "d"
    label: "auto chain"
    how: "The service accepts new signers automatically when a signer-change chain links them to keys it already trusts."
    tradeoff: "No admin step is needed. A chain produced elsewhere is trusted without anyone at the service reviewing it."
choice:
  option: "a"
  reason: "Files added outside the service may be signed by keys it never trusted. A single admin-signed admission handles those signers while keeping the original signatures. It also puts the signer-change chain in front of a person who can judge it. This follows D5, where an admin at base signs whatever earlier history is admitted. The source is ambiguous because #2524 names the other options without giving reasons. The reasons here are derived from D5 and D10."
rejected:
  - option: "b"
    why: "Attesting again under the service's key hides who wrote each change."
  - option: "c"
    why: "Returned work would stay `adopted` even when its signers could be verified."
  - option: "d"
    why: "It would trust signer rotations made where the service had no say."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D10. Export and fork"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d10-export-and-fork"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d5-provenance"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2552, export, import and hosted return"
    url: "https://github.com/INTENTIUS/chant/issues/2552"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2552"
---

# Hosted return
