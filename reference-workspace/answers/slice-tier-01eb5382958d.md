---
id: "slice-tier-01eb5382958d"
title: "Which builder tier builds this work item (W-001): small"
point: "slice-tier"
point_version: "1da30972296365f5fe0537e9b49ec33ad03b49c74843abf35e91421dac412e4d"
question_type: "choice"
candidates:
  - "small"
  - "medium"
  - "large"
inputs:
  "work-item.criteria": 2
  "work-item.files": 1
  "work-item.words": 140
  "work-item.fits_small": true
  "work-item.fits_medium": true
inputs_hash: "01eb5382958d4ae82aaa4ff4e44f21a69def3639970ae04ee80aac251d58deac"
constrains:
  - "W-001"
state: "answered"
answer: "small"
decider:
  kind: "table"
  row: 0
asked_on: "2026-09-25"
answered_on: "2026-09-25"
source:
  via: "cli"
---

# Which builder tier builds this work item (W-001): small

Pick the smallest builder tier that can build this work item. The state is how much the work item holds and whether that fits each tier's sizing limits.

- small: A haiku-class builder. The work item fits the small limits.
- medium: A mid-size builder. The work item fits the medium limits.
- large: The largest builder. The work item is bigger than the medium limits.
