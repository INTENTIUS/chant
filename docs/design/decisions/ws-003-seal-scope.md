---
schema: 1
id: "ws-003"
title: "Seal scope"
state: "decided"
area: "D4"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Seal scope"
  revision: null
question: "What part of a record file does its seal cover?"
options:
  - id: "a"
    label: "whole file"
    how: "The seal covers the whole file after line endings are normalised. Styling that may change sits in separate referenced files such as stylesheets."
    tradeoff: "Anything a check or an agent reads is sealed, and no extractor has to find regions. A record can't hold its own changeable styling."
  - id: "b"
    label: "in-file regions"
    how: "A kind marks regions inside a record that stay outside the seal, such as display blocks."
    tradeoff: "Records can carry their own styling. This needs a strict HTML5 extractor that refuses duplicate or hidden cores."
  - id: "c"
    label: "generated only"
    how: "Only the sealed core is stored, and the view of a record is always generated from it."
    tradeoff: "Records stay fully sealed. Authors can't write any display text by hand."
choice:
  option: "a"
  reason: "A whole-file seal leaves no unsealed text in a record, so a reader can't be shown content the seal doesn't cover. Styling can still change in separate referenced files. The v3 open question noted that in-file regions would need a strict extractor that refuses duplicate or hidden cores. The source is ambiguous because the label \"generated only\" stands for \"presentation generated only\" in the v6 table. #2524 does not describe how it would work, so the description here is derived."
rejected:
  - option: "b"
    why: "An extractor that missed a duplicate or hidden core would let unsealed text pass as record content."
  - option: "c"
    why: "It removes hand-written styling, which separate referenced files keep without weakening the seal."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D4. Records"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d4-records"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2546, records, seals and the spec query"
    url: "https://github.com/INTENTIUS/chant/issues/2546"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2546"
---

# Seal scope
