---
schema: 1
id: "ws-001"
title: "Trust root"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Trust root"
  revision: null
question: "Where does a workspace keep the list of trusted signers and role grants, and which attestor ships first?"
options:
  - id: "a"
    label: "repo signer file read from base; ssh commits"
    how: "An `allowed_signers` file and role grants live in the repo and are always read from the base revision. The first attestor verifies ssh-signed commits against that file."
    tradeoff: "Works offline on any forge with keys developers already have. Changing the file is itself a protected write, and rotation needs a threshold of the old signers."
  - id: "b"
    label: "protected ref"
    how: "Signers and grants live on a separate protected git ref that checks read."
    tradeoff: "Keeps policy out of the main tree. Checks then depend on the forge protecting that ref and on every clone fetching it."
  - id: "c"
    label: "forge settings"
    how: "The forge's own settings, such as branch protection and signature rules, say who may sign."
    tradeoff: "Nothing to keep in the repo. The policy can't be read from a git revision offline, and it differs per forge."
  - id: "d"
    label: "keyless first"
    how: "The first attestor uses keyless Sigstore signing, with identities from an OIDC sign-in."
    tradeoff: "No long-lived keys to manage. Signing and verifying need network access to outside services."
choice:
  option: "a"
  reason: "The threat model requires checks to read signers and grants from the base revision, and a file in the repo can be read that way offline. ssh-signed commits need no new infrastructure. A new signer set is signed by a threshold of the old one, and DSSE follows later for runner evidence. The source is ambiguous because #2524 names the three alternatives without saying why each lost. The reasons given for them here are derived from the threat model and D5."
rejected:
  - option: "b"
    why: "A ref outside the main tree needs its own protection and fetch, and a missing ref can only be reported as unverified."
  - option: "c"
    why: "Forge settings can't be read from a git revision offline, and D19 says core never touches forge settings."
  - option: "d"
    why: "Keyless signing needs egress to sign and to verify, while `workspace check` runs under the no-egress guard."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D5. Provenance"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d5-provenance"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2547, attestors and policy read from the base revision"
    url: "https://github.com/INTENTIUS/chant/issues/2547"
    as_of: null
  - title: "INTENTIUS/chant#2553, signer rotation and DSSE runner evidence"
    url: "https://github.com/INTENTIUS/chant/issues/2553"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2547"
  - "INTENTIUS/chant#2553"
---

# Trust root
