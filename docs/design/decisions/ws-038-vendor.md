---
schema: 1
id: "ws-038"
title: "Vendor"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Vendor (v8)"
  revision: "v8"
question: "How does `chant vendor` relate to the workspace lineage lock?"
options:
  - id: "a"
    label: "a lineage scope"
    how: "`chant vendor` becomes one lineage scope type, copied with no parameters. The lock takes over `vendor.json`, and per-file merge replaces `pull` deleting local edits."
    tradeoff: "One lock records where every copied file came from, and vendored code gains the upgrade merge. Existing `vendor.json` files have to be migrated into the lock."
  - id: "b"
    label: "separate"
    how: "`chant vendor` keeps `vendor.json` and its own `pull`, apart from the lineage lock."
    tradeoff: "No migration is needed. The workspace would record origin in two places, and `pull` would keep deleting local edits."
  - id: "c"
    label: "grow `vendor.json`"
    how: "`vendor.json` gains lineage fields and becomes the record for vendored scopes."
    tradeoff: "Existing files keep their name. It would duplicate the lock's lineage format in a second file."
choice:
  option: "a"
  reason: "D9 treats vendoring as one kind of lineage scope, so origin lives in the lock as D13 requires. Vendored files then get the per-file merge that template files use, which stops `pull` from deleting edits. The row is new in v8; the v6 and v7 texts do not mention vendor."
rejected:
  - option: "b"
    why: "Keeping vendor separate would record origin outside the lock and keep `pull` deleting local edits."
  - option: "c"
    why: "Growing `vendor.json` would build a second lineage format beside the lock."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D13. Kind is not origin"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d13-kind-is-not-origin"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Vendor (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2540, write the lineage lock at init, with vendor as a lineage scope"
    url: "https://github.com/INTENTIUS/chant/issues/2540"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2540"
---

# Vendor
