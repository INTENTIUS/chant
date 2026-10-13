---
schema: 1
id: "C-001"
title: "The home page follows its screen spec"
state: "draft"
criteria:
  - id: "a1"
    text: "Given the app is running, when I open the home page, then it shows the header and status regions design/screens/home.json lists"
  - id: "a2"
    text: "Given the app is running, when I ask its health check, then it answers ok"
checks:
  - title: "The check for C-001, run with node --test against APP_URL"
    path: "design/contracts/checks/C-001.test.mjs"
    sha256: "a05b911ec0887173fcda3e1a583aa2fc8309ece5d4298125c6aa36f45bd9138b"
reviews: []
approved_by: null
tier: "small"
---

# The home page follows its screen spec

As someone opening the app, I want its home page to be the one the design member specifies, so that what was designed is what I see.

The criteria are in the front matter, and `checks/C-001.test.mjs` checks each against the running app: a test named `a1: ...` checks `a1`. The contract stays a draft until its reviewers agree; approving it sets `state` and `approved_by` with `chant workspace records amend`, or a review session's verdicts do.
