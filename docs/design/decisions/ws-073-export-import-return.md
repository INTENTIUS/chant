---
schema: 1
id: "ws-073"
title: "Export, import, and what a hosted return carries"
state: "decided"
area: "D10"
source:
  issue: "INTENTIUS/chant#2552"
  row: "Exports write into their own member; host-bound parameters switch on export and import; a hosted service admits new signers on return by an admin-signed record"
  revision: null
question: "What does `chant workspace export` write and where, how does `import` bring a copy back and decide what to write, and how does work signed where the copy lived reach the trust policy of the workspace it returns to, with its original signatures, so ws-004's admission has something exact to admit?"
options:
  - id: "a"
    label: "an export member found by role; a per-file merge against the export's hashes; a return record carrying each returned file's commit and the tree objects down to it; admissions per return in .chant/trust.json"
    how: "Export writes into the one member of kind workspace with role export (or the one --to names), refusing a layout where that member is inside another or another is inside it. Only members with travel: true go; with no member named, all of them and the workspace's own record kinds. The export keeps the workspace's layout, gets a declaration with the members that went (links, agents and path pins to members that stayed are left out and listed), the lineage of each scope filtered to the files that went, and .chant/export.json with each file's hash here and in the export. A lineage records its host-bound parameters with the files that carry them (hostBound, written by init --from); export --param switches them and import switches them back. Import compares three hashes per file and per lineage scope, refuses the whole import on a conflict or on a file outside the members that went, writes .chant/returns/<id>.json, and writes the export member again or removes it with --remove. When the copy is a git repository of its own, each written file whose bytes are the copy's carries the raw commit that last changed it and the raw trees from its root down, so the bytes are tied to the signed commit offline. records judges such a file by that commit with the attestors of #2547: a signer the base policy does not list reads attested-unverifiable-here. chant workspace admit <id> adds the return's signers to .chant/trust.json under admitted, keyed by the return; once merged at base they verify that return's commits and seals only."
    tradeoff: "No signature is made again, and the proof needs only git's own object hashing, so it checks offline and in CI. The admission is a policy edit, already a protected write, so the admin's signed commit is the admin-signed record. A return record grows with the depth of each path and the size of the copy's trees. Files whose host values were switched back are not the copy's bytes, so they carry no origin and count as the importer's."
  - id: "b"
    label: "merge the copy's history into the workspace's"
    how: "Import fetches the copy's commits and makes them a second parent of the import commit, so `git log` attributes each file to the commit that made it."
    tradeoff: "The commits stay as git history with no new format. The copy starts with a commit that adds every exported file, so in a merge that takes some files from each side git's history walk can name that commit as the author of files the workspace wrote, and every file then reads as the copy's signer until admitted. It also asks the user to commit a merge of unrelated histories."
  - id: "c"
    label: "the importer vouches for everything"
    how: "Import writes the files; the commit that adds them is the only provenance."
    tradeoff: "Nothing new to verify. Authorship outside is lost, which is what ws-004 rejected the service re-signing for."
  - id: "d"
    label: "export to any directory, with no member"
    how: "`export --out <dir>` writes anywhere, and the declaration has no export member."
    tradeoff: "Simpler to call. D10 asks that exports write into their own member and never into another, and a free path could land in one."
choice:
  option: "a"
  reason: "D10 fixes the target (its own member, found by role) and the admission (an admin signs a record admitting new signers; original signatures stay). A per-file merge against recorded hashes is the rule D9 already uses for upgrades, so an import never overwrites work done here. Carrying the commit object and its trees is the smallest thing that keeps the original signature checkable: the commit id is the hash of the object that holds the signature, and each tree id the hash of the tree that names the next, down to the file's bytes. Putting the admission in trust.json, keyed by return, follows ws-070, which put adoption there for the same reason, and keeps the admitted key from vouching for anything made in the workspace itself."
rejected:
  - option: "b"
    why: "History merged from an unrelated root misattributes unchanged files to the copy's first commit."
  - option: "c"
    why: "It loses who made the work, the thing ws-004 keeps."
  - option: "d"
    why: "D10 requires the export's own member and refuses paths owned by another."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2552, export, import and hosted return, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2552"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D9 and D10, scenario 4"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-004, Hosted return"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-004-hosted-return.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-070, Adoption under P7"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-070-adoption.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2552"
  - "path:packages/core/src/workspace/export.ts"
  - "path:packages/core/src/workspace/import.ts"
  - "path:packages/core/src/workspace/returns.ts"
---

# Export, import, and what a hosted return carries

The commands are described in [chant workspace export](https://intentius.io/chant/cli/workspace-export/), the `hostBound` field in [Lineage Lock](https://intentius.io/chant/reference/lineage-lock/), and the `admitted` list in [chant workspace verify](https://intentius.io/chant/cli/workspace-verify/).

A hosted service's own identity on a return, a DSSE statement by its service key over the return record (#2553), is not part of this record; it is a follow-up.
