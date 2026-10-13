---
schema: 1
id: "ref-003"
title: "What the app is for"
state: "proposed"
area: "delivery"
source:
  issue: "INTENTIUS/chant#2850"
  row: "What the app is for"
  revision: null
question: "What is the app box for?"
options:
  - id: "a"
    label: "a status page for the product"
    how: "The app serves one page that says whether the product is up, laid out by the home screen spec in the design member."
    tradeoff: "Small enough for CI to build and test offline. It shows nothing a person would act on."
  - id: "b"
    label: "a review queue for the design team"
    how: "The app lists the design records waiting on a person and links each to its screen."
    tradeoff: "Closer to what a box is planted for. It needs the records at run time, which the fixture's image does not carry."
choice: null
rejected: []
supersedes: []
evidence: []
decided_by: null
decided_on: null
reviews: []
constrains:
  - "member:app"
proposed_by: "lex00"
---

# What the app is for
