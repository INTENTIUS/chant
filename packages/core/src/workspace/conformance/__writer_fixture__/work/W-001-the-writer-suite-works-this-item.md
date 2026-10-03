---
schema: 1
id: "W-001"
title: "The writer suite works this item"
state: "open"
implements: []
needs: []
constrains:
  - "member:delivery"
evidence: []
acceptance:
  - id: "AC-1"
    text: "A run under the item's lease attaches evidence for this criterion through chant"
    verification: "unit"
owner: "conformance"
opened_on: "2026-01-01"
source:
  kind: "workspace"
  member: "delivery"
supersedes: []
---

# The writer suite works this item

The writer conformance suite (INTENTIUS/chant#3159) claims this item's lease, renews it, attaches evidence for AC-1 and releases it, each through the writer under test.
