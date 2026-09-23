---
schema: 1
id: "ws-042"
title: "Root CI files"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Root CI files (v8)"
  revision: "v8"
question: "Which member owns forge CI files at the repo root, such as `.github/workflows/*`?"
options:
  - id: "a"
    label: "source member, exempted"
    how: "The member whose code generates a root CI file owns it, through a narrow exemption for forge paths. A `WSP` rule allows exactly one declarer per file."
    tradeoff: "Ownership follows the generator, so drift checks point at the right member. Root ownership gains one special case."
  - id: "b"
    label: "member `.`"
    how: "The root project, listed as `.`, owns them, since it owns the root minus the other members (D1)."
    tradeoff: "Needs no exemption. The owner and the generator differ, and a workspace whose root isn't a project has no `.` to own them."
  - id: "c"
    label: "a `ci` member"
    how: "A dedicated `ci` member holds every forge file."
    tradeoff: "One place to look. The member owns files it doesn't generate, at root paths outside its own directory."
choice:
  option: "a"
  reason: "Forges read these files from fixed paths at the repo root, so they can't live in the directory of the member that generates them. D14 ties each generated file to its source and command, and the exemption keeps that tie. The one-declarer rule stops two members from writing the same file. The row is new in v8."
rejected:
  - option: "b"
    why: "The generating code lives in another member, and the chant repo's own root is an npm workspace with no member `.` (#2557)."
  - option: "c"
    why: "A `ci` member would own output it doesn't produce, which splits a generated file from its source."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Root CI files (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D14. Generated files"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d14-generated-files"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2542, per-member CI pipelines with path filters, and root CI ownership"
    url: "https://github.com/INTENTIUS/chant/issues/2542"
    as_of: null
  - title: "INTENTIUS/chant#2541, generated files per member, with drift checks"
    url: "https://github.com/INTENTIUS/chant/issues/2541"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2542"
  - "INTENTIUS/chant#2541"
---

# Root CI files
