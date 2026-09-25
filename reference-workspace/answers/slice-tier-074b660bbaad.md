---
id: "slice-tier-074b660bbaad"
title: "Which builder tier builds this work item (W-002): medium, proposed"
point: "slice-tier"
point_version: "1da30972296365f5fe0537e9b49ec33ad03b49c74843abf35e91421dac412e4d"
question_type: "choice"
candidates:
  - "small"
  - "medium"
  - "large"
inputs:
  "work-item.criteria": 5
  "work-item.files": 4
  "work-item.words": 780
  "work-item.fits_small": false
  "work-item.fits_medium": false
inputs_hash: "074b660bbaadf40ee1c3d44de8ee9ebb70136a987a6546c0acbaf041fefc486d"
constrains:
  - "W-002"
state: "proposed"
answer: "medium"
decider:
  kind: "model"
  backend: "systemone"
  model: "bosun-v3.1-1.7b"
probabilities:
  small: 0.03
  medium: 0.91
  large: 0.06
confidence: 0.865
threshold: 0.8
escalations:
  - kind: "table"
    reason: "no row matches these inputs"
asked_on: "2026-09-25"
source:
  via: "cli"
  model: "bosun-v3.1-1.7b"
---

# Which builder tier builds this work item (W-002): medium, proposed

Pick the smallest builder tier that can build this work item. The state is how much the work item holds and whether that fits each tier's sizing limits.

- small: A haiku-class builder. The work item fits the small limits.
- medium: A mid-size builder. The work item fits the medium limits.
- large: The largest builder. The work item is bigger than the medium limits.
