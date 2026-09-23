---
schema: 1
id: "ws-031"
title: "Plugin shape"
state: "decided"
area: "D3"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Plugin shape (v8)"
  revision: "v8"
question: "How does a plugin supply member kinds to chant?"
options:
  - id: "a"
    label: "data-only `./workspace-kinds` subpath"
    how: "A plugin exports its kinds from a data-only `./workspace-kinds` subpath, or from a kinds-only package, following the slim `/detect` import (#426)."
    tradeoff: "Reading kinds never loads the lexicon itself, so listing a workspace stays cheap. Each lexicon that supplies a kind publishes one more entry point."
  - id: "b"
    label: "field on plugins"
    how: "One `workspaceKinds` contribution is an optional field on an existing `LexiconPlugin` or `CapabilityPlugin`, or is exported on its own."
    tradeoff: "The terraform lexicon adds its member kind without a second package. Reading the field means importing the plugin module, which loads the lexicon."
    chosen_in: "v6"
  - id: "c"
    label: "core table"
    how: "chant core keeps a table of known member kinds and their probes."
    tradeoff: "Nothing extra to load. Every new kind needs a chant release, and core would carry kinds for tools it does not ship."
choice:
  option: "a"
  reason: "The choice was revised in v8 from a field on plugins, chosen in v6; the earlier choice is in the #2524 edit history. D3 requires that reading kinds never loads the lexicon itself, and a data-only subpath does that the same way #426 did for `/detect`. The vocabulary stays closed and plugin-supplied."
rejected:
  - option: "b"
    why: "A field on the plugin object can only be read by importing the lexicon, so every workspace read would pay for loading every lexicon that supplies a kind."
  - option: "c"
    why: "A core table would put domain kinds in core and tie each new kind to a chant release, where D3 has plugins supply them."
supersedes:
  - revision: "v6"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D3. Kinds"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d3-kinds"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Plugin shape (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#426, extract detectTemplate into edge-safe modules"
    url: "https://github.com/INTENTIUS/chant/issues/426"
    as_of: null
  - title: "INTENTIUS/chant#2535, member kinds from a data-only subpath, and WorkspaceCheck"
    url: "https://github.com/INTENTIUS/chant/issues/2535"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2545"
---

# Plugin shape
