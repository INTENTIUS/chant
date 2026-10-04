---
schema: 1
id: "ws-093"
title: "An app member kind with declared fields"
state: "decided"
area: "D3"
source:
  issue: "INTENTIUS/chant#3151"
  row: "workspace: an app member kind (scripts, port, data, health) as a data-only kinds file"
  revision: null
question: "How does a workspace declare that a member is an app, with the conventions an orchestrator runs it by (its start, dev, test and migrate scripts, the port, data and revision variables, the health path), so that studio's factory, the release Op and any second orchestrator read them from the spec instead of assuming them, and where does the kind come from?"
options:
  - id: "a"
    label: "a data-only kinds file chant ships and a workspace pins a copy of by path, with fields a kind declares and a member sets"
    how: "The kinds file format gains two optional parts. A kind may declare fields: each a string, integer or boolean with a description, an optional default and, for a string, an optional pattern, or an object of such fields. A probe may use anyJsonKey { in, pointers }, which passes when a named JSON file directly in the directory has a value at one of the JSON Pointers. A member entry sets values under fields. chant workspace check fails a field the kind doesn't declare or a value of the wrong type with WSP005, and chant workspace status --json prints members[].fields with every declared field, defaults filled in. The app kind is one such file: precedence 100, a probe for package.json with /scripts/start, outputs source and url, and fields scripts { start, dev, test, migrate }, env { port, data, revision } and health, defaulting to studio's conventions. Its canonical copy ships in @intentius/chant at src/workspace/reference-kinds/app, as a package.json that exports ./workspace-kinds and the file; a workspace copies that directory and pins it by path, as the reference workspace does at kinds/app."
    tradeoff: "The vocabulary stays closed and plugin-supplied as ws-031 chose, nothing is imported, and a workspace that doesn't pin the kind sees nothing new. Fields are generic, so a terraform or helm kind can declare its own conventions the same way. Each workspace carries a copy of the kind, which it updates by copying again (or through its template's lineage), and the probe looks for the conventional start script, so a member that names its start script otherwise still needs one called start for the probe to claim it."
  - id: "b"
    label: "a built-in app kind in core"
    how: "kinds.ts gains app beside chant, workspace, design and other, with its fields in code."
    tradeoff: "No pin and no copy. ws-031 rejected a core table, and every workspace would see the kind, so every other member that is a Node package with a start script would fail WSP008 in workspaces that never asked for apps, including infra and records-only ones (#3174)."
  - id: "c"
    label: "@intentius/chant exports ./workspace-kinds and a workspace pins chant itself"
    how: "The kinds file ships at the core package's own subpath, and a declaration that pins @intentius/chant at an exact version gets the app kind."
    tradeoff: "One copy, versioned with chant. Pinning chant also makes the pinned version the only chant that may read the declaration (ws-021), so every reader of a studio repo, hud included, would have to run that exact chant, a far larger commitment than wanting an app kind."
  - id: "d"
    label: "keep the conventions in delivery's buildParams"
    how: "Studio's template declares appStart, appMigrate, appTest and appHealth as buildParams in delivery's chant.config.ts, and the app member stays kind other."
    tradeoff: "Nothing new in chant. The conventions stay in one chant project's config, which only code that loads that config reads, and the app member stays a directory chant does not read."
choice:
  option: "a"
  reason: "#3145 moves what studio relies on into the spec, and ws-031 says kinds are data from a pin. A pinned copy keeps both: the kind is opt-in per workspace, readers never run its code, and the declaration's chant pin is untouched. Declared fields with defaults make the conventions explicit without making a member restate them, and the read contract prints the resolved values so an orchestrator stops reading package.json and environment knobs for them. The JSON-key probe claims a Node package only when it has a start script, so a repository root or a tools package with scripts stays other. Fields are a property of kinds in general, not of the app kind, so later kinds (#3179) reuse them."
rejected:
  - option: "b"
    why: "A core table is what ws-031 rejected, and an always-on app probe would fail other members in workspaces that never asked for it."
  - option: "c"
    why: "Pinning chant pins the reader version for every reader of the workspace; the kind would cost more than it gives."
  - option: "d"
    why: "The conventions stay where only the release Op and the studio kit can read them, and the app member stays opaque."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3151, an app member kind as a data-only kinds file"
    url: "https://github.com/INTENTIUS/chant/issues/3151"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#3174, factory fields are opt-in, with ideation, app and infra profiles"
    url: "https://github.com/INTENTIUS/chant/issues/3174"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#288, ideation repos get a stub app"
    url: "https://github.com/arugula-salad/studio/issues/288"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-031, plugin shape"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-031-plugin-shape.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3145"
  - "INTENTIUS/chant#3174"
  - "INTENTIUS/chant#3179"
  - "arugula-salad/studio#287"
  - "arugula-salad/studio#288"
  - "ws-031"
---

# An app member kind with declared fields
