---
schema: 1
id: "ws-070"
title: "Adoption under P7, and moving a directory lineage onto git"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2551"
  row: "adopt-lineage proposes a lineage with matching files and records it under P7; Bridge migrations bring fork-born workspaces forward"
  revision: null
question: "How does `chant workspace adopt-lineage` record an adoption so that D5's rule (an exact commit range, admitted by an admin at base, shown as `adopted`) holds; what does it do for a scope that already has a directory lineage, such as a studio box whose template directory a kit release replaced; and what is a bridge migration?"
options:
  - id: "a"
    label: "the range goes into .chant/trust.json, provenance is read at base; a directory lineage moves onto git only at a version that reproduces every recorded hash; a bridge is a migration whose from.template names the old template, run by upgrade --source"
    how: "A scope with no lineage is matched against the template's versions (hash index from tags, ws-006), and the lineage records `adoption: { by: \"files\", commits: { to: HEAD }, match, index }`. adopt-lineage adds `{ to: HEAD, note }` to the `adopted` list of `.chant/trust.json`, the policy file #2547 reads at base, where an edit is a protected write. `chant workspace lineage` and `versions` report `adopted` when the policy at base admits the range, `unattested` until then. A scope whose lock holds a `dir` source is moved onto `--from <repo>[#<member>]` at the version whose files, rendered with the recorded parameters, have every hash the lock recorded; the lineage keeps its files, parameters and migrations and records `adoption: { by: \"lineage\", previous }`, with no trust entry. `chant workspace upgrade --source <repo> --to <ref>` moves a git scope to another template, starting the chain with a migration the new template ships whose `from.template` is the scope's template; the merge base stays the scope's own source."
    tradeoff: "The adoption is admitted by the same review that admits any policy change, with no new signing mechanism, and the lineage never claims more than the policy says. The trust file gains one line per adoption. Moving a directory lineage needs the repository to hold the exact files the directory was copied from, at a tag or at a ref the user names."
  - id: "b"
    label: "an attestation field on the lineage, signed by an admin's ssh key"
    how: "adopt-lineage asks for an admin's signature over the range and stores it in the lock (`adoption.attestation`), checked against the signers file at base."
    tradeoff: "The lock carries its own proof. It needs a second signing path beside signed commits and rotation, and a lock edit by anyone could still drop or replace the field, so the check would have to be anchored at base anyway."
  - id: "c"
    label: "show every adopted lineage as adopted, unsigned"
    how: "The WIP of 2026-09-23: `adoption.provenance: \"adopted\"` and `attestation: null` until attestors exist."
    tradeoff: "Simple, but anyone running the command makes their history read as `adopted`, which is what D5 forbids. Attestors exist since #2547, so the reason to wait is gone."
  - id: "d"
    label: "re-run adopt-lineage from files for a directory lineage"
    how: "Treat a directory-lineage scope like one with no lineage and match the working tree against the tags."
    tradeoff: "No special case, but the working tree holds the box's own edits, so the match is approximate and the merge base can move. The lock already knows the exact hashes the scope was made from."
choice:
  option: "a"
  reason: "D5's adoption is a policy fact, and #2547 already reads policy at base with protected writes, so the range belongs in the policy, not in a field anyone can edit. For a directory lineage the recorded hashes are the merge base itself, so requiring every one of them at the chosen version keeps upgrades exact, and the commit history before the lock is not in question. Bridges reuse the migration format with the field it already had (`from.template`), so a fork-born workspace is adopted against the fork it came from and moved onward by the upstream's own data."
rejected:
  - option: "b"
    why: "A second signing path for the same fact, and the signature would still have to be checked at base."
  - option: "c"
    why: "It shows `adopted` without anyone at base admitting it."
  - option: "d"
    why: "It throws away the exact merge base the lock holds and guesses it from an edited tree."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2551, adopt-lineage and nesting, audit of 2026-09-30, and the studio use case of 2026-09-26"
    url: "https://github.com/INTENTIUS/chant/issues/2551"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance and D9. Templates and upgrade, scenario 6"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-006, Hash index"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-006-hash-index.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "arugula-salad/studio#46, every box's operational work runs through a chant Steward"
    url: "https://github.com/arugula-salad/studio/issues/46"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2551"
  - "path:packages/core/src/workspace/lineage-adopt.ts"
  - "path:packages/core/src/workspace/lineage-provenance.ts"
---

# Adoption under P7, and moving a directory lineage onto git

The command is described in [chant workspace adopt-lineage](https://intentius.io/chant/cli/workspace-adopt-lineage/), the lock fields in [Lineage Lock](https://intentius.io/chant/reference/lineage-lock/#adoption), and bridges in [Template Migrations](https://intentius.io/chant/reference/template-migrations/#bridge-migrations).

A box that cannot reach the template repository at upgrade time still needs its old template directory, or a git lineage it can fetch. Upgrading a git lineage from a directory carried on the host, with the base from git, is #3095.
