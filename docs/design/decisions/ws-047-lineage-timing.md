---
schema: 1
id: "ws-047"
title: "Lineage timing"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Lineage timing (v8)"
  revision: "v8"
question: "When does a workspace made from a template get its lineage lock?"
options:
  - id: "a"
    label: "lock at init in phase 1"
    how: "`chant init --from` and `chant init --template` write the lock from phase 1, so no workspace starts without lineage."
    tradeoff: "Workspaces made early can be upgraded later with no extra step. The lock format has to settle in phase 1."
  - id: "b"
    label: "after signing"
    how: "The lock ships in phase 5 with templates and upgrade, after the signing work."
    tradeoff: "The lock is designed alongside migrations. Every workspace made before then needs adopt-lineage."
  - id: "c"
    label: "deferred"
    how: "Lineage is left out of the phased plan."
    tradeoff: "Less work now. Upgrades keep relying on hand-written migrations."
choice:
  option: "a"
  reason: "A lock written at init captures the template and its parameters while they are known. Recovering them later means matching file hashes with adopt-lineage. Writing it needs nothing from records or signing, and the lineage level already works for a plain project (D0). The same change folds `chant vendor` into the lock as one lineage scope (#2540). The source is ambiguous because v6 and v7 put the lock and lineage in phase 5, after records and signing, which is option b, but the table marks no option as chosen in an earlier revision."
rejected:
  - option: "b"
    why: "Workspaces made before the lock existed would each need adopt-lineage later."
  - option: "c"
    why: "Generated repos would keep drifting from their template, which is the cost the framing starts from."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Lineage timing (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Phasing"
    url: "https://github.com/INTENTIUS/chant/issues/2524#phasing"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2540, write the lineage lock at init, with vendor as a lineage scope"
    url: "https://github.com/INTENTIUS/chant/issues/2540"
    as_of: null
  - title: "INTENTIUS/chant#2550, migrations and chant workspace upgrade (phase 5)"
    url: "https://github.com/INTENTIUS/chant/issues/2550"
    as_of: null
  - title: "INTENTIUS/chant#2551, adopt-lineage, the hash index, version reports and nesting (phase 5)"
    url: "https://github.com/INTENTIUS/chant/issues/2551"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2540"
  - "INTENTIUS/chant#2550"
  - "INTENTIUS/chant#2551"
---

# Lineage timing
