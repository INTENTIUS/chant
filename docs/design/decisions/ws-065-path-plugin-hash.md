---
schema: 1
id: "ws-065"
title: "Content hash of a path-loaded plugin"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2547"
  row: "Plugins loaded by path are pinned by content hash"
  revision: null
question: "A pin by path may carry integrity, and nothing checks it. What does the hash cover for a directory, in what form is it written, and what happens on a mismatch?"
options:
  - id: "a"
    label: "SRI over a manifest of the directory's files"
    how: "integrity stays a Subresource Integrity string, sha256-, sha384- or sha512- and base64. A directory's value is that algorithm over a manifest with one line per regular file, its own digest in hex and its path from the directory, sorted by UTF-16 code unit. node_modules and .git are skipped and a symbolic link is refused. chant checks it whenever it loads kinds from the pin, leaves the plugin out and reports the expected and actual values on a mismatch, and chant workspace pin <path> prints the value."
    tradeoff: "One value in the form the declaration already accepts, covering every file the plugin could load, with the working tree as the input, so build output inside the directory changes it. Pins are written for directories that hold only committed files."
  - id: "b"
    label: "hash only the tracked files, as git lists them"
    how: "The manifest covers `git ls-files` for the directory."
    tradeoff: "Stable against build output, but the hash then depends on git being present and on the index, and a check under --at reads a different set than the one on disk."
  - id: "c"
    label: "a tarball digest"
    how: "Pack the directory as npm does and hash the tarball."
    tradeoff: "Matches npm's own integrity, but tar output varies with the tool, file order and timestamps unless pinned down, and the declaration would depend on a packer."
choice:
  option: "a"
  reason: "The schema already accepts an SRI string, so no contract changes, and a manifest of file digests needs nothing but file reads, which keeps the check usable under any command that reads a declaration. The tracked-file form would tie a security check to git state, and the tarball form to a packer. A mismatch leaves the plugin's kinds out and the check names both values, so a change that was meant to happen is one `chant workspace pin` away from accepted. A package pin keeps its meaning: its integrity is a registry tarball digest that chant does not recompute, and is still unchecked."
rejected:
  - option: "b"
    why: "It makes the check depend on git and on the index."
  - option: "c"
    why: "It depends on a packer's output being stable."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2547, attestors, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2547"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5 and the threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2547"
---

# Content hash of a path-loaded plugin

The hash is read from the declaration in the working tree. A change that edits a plugin and its pin together changes both, so the pin protects against a plugin edited without the declaration, not against a change under review. Reading plugin pins from the base revision belongs to the same step as moving the role grants into the declaration, which ws-001 does not call for.

Record kind files named in `records` are imported code and carry no `integrity` field. They are not covered.
