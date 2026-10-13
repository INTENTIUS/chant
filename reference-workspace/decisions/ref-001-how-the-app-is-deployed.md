---
schema: 1
id: "ref-001"
title: "How the app is deployed"
state: "decided"
area: "delivery"
source:
  issue: "INTENTIUS/chant#2543"
  row: "How the app is deployed"
  revision: null
question: "What builds the app's image and runs it?"
options:
  - id: "a"
    label: "a chant project with the docker lexicon"
    how: "The delivery member is a chant project. It declares the app as a Docker Compose service built from the app's own Dockerfile, and `chant build` writes the compose file."
    tradeoff: "The deployment is typed, linted and built by chant, so it exercises a real `chant` member. The app and its deployment are two members, joined only by a build-context path until member links land."
  - id: "b"
    label: "a hand-written compose file in the app"
    how: "The app directory holds its own `docker-compose.yml`, written and kept by hand."
    tradeoff: "One member fewer and nothing to build. Nothing checks the file, and the workspace would have no `chant` member to test."
  - id: "c"
    label: "a hosted platform lexicon"
    how: "The delivery member deploys the app to a hosted platform through a lexicon such as fly or render."
    tradeoff: "Closer to production. CI would need an account or an emulator for a check that only has to prove the member builds."
choice:
  option: "a"
  reason: "The reference workspace needs a `chant` member that CI can build and lint offline, and Compose needs no account or emulator. Keeping the Dockerfile in the app lets the app build on its own, whatever deploys it."
rejected:
  - option: "b"
    why: "It leaves the workspace without a `chant` member, and nothing would check the file."
  - option: "c"
    why: "CI would need a platform account or emulator for a fixture whose job is to build and lint."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2543, the reference spec-and-skeleton workspace as a walking skeleton"
    url: "https://github.com/INTENTIUS/chant/issues/2543"
    as_of: "2026-09-24T01:50:08Z"
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-24T01:50:08Z"
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "member:app"
  - "member:delivery"
---

# How the app is deployed
