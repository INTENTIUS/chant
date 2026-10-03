---
schema: 1
id: "ws-079"
title: "Principal classes from plugins"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#3080"
  row: "Principal classes: human, agent, runner, service in core; domain classes from plugins"
  revision: null
question: "#2524 D5 lists human, agent, runner and service as core principal classes, with domain classes from plugins, and ws-067 shipped write scope for the core four only. Where does a plugin declare a class, which grant puts a principal in it, how does writeScope name it, and what happens when the declaration names a class nothing supplies, so that #3163 can rest person-attributed records and gates on a declared class?"
options:
  - id: "a"
    label: "a data-only ./workspace-principals subpath; each class names the role whose grant at base puts a principal in it; writeScope takes any class name and fails closed on an unknown one"
    how: "A pinned package exports a JSON file at ./workspace-principals, beside ./workspace-kinds and under the same rules (the literal key, a .json target inside the package, never imported). It lists classes, each a name, a description and a role. A principal's classes are read from the role grants at base through one function, classesOf: the core agent, runner and service roles first, then the domain classes in pin order and file order; the first that holds is the class write scope judges it as, and human is the rest. writeScope accepts any class name as a key. A path pin is read at the base revision when the caller has it, so write scope reads the plugin where it reads the declaration and the trust policy. A class name or role two pins supply is left out. A writeScope key no pin supplies fails workspace check with WSP003, and a writer judged human is refused with write-scope-class-unknown, since it may be in that class."
    tradeoff: "A class is only a name for a role, so who is in it stays in the one place roles are granted, and the plugin decides only the vocabulary. A separate subpath keeps old chants reading a plugin's kinds unchanged. The cost is one more data file per plugin, and a principal granted two domain classes' roles is judged by the first in pin order."
  - id: "b"
    label: "classes in the ./workspace-kinds file"
    how: "workspace-kinds.json gains an optional principalClasses list beside kinds."
    tradeoff: "One file per plugin. The kinds file refuses fields it doesn't know, so every chant before this one would refuse a plugin's kinds as soon as it listed a class, failing WSP002 for a workspace that never used the class."
  - id: "c"
    label: "classes declared in chant.workspace.json"
    how: "The declaration gains principalClasses: [{ name, role }], and writeScope names those."
    tradeoff: "No plugin needed, and the class is read at base with the declaration. It isn't what D5 says: a domain's vocabulary (a review plugin's reviewer, an infra plugin's operator) would be retyped in every workspace that uses the domain, and two workspaces could give one class name two meanings."
  - id: "d"
    label: "an unknown writeScope key is ignored, and its principals are humans"
    how: "As option a, but a writeScope entry for a class no pin supplies has no effect."
    tradeoff: "Nothing breaks while a plugin is missing. Restricting a domain class while leaving human open then widens silently whenever the plugin isn't installed at the pinned version."
choice:
  option: "a"
  reason: "D5 puts domain classes in plugins, and ws-031 already gives plugins a data-only subpath that chant reads without importing; a sibling subpath follows it without changing what older chants accept. A class names a role rather than listing principals, so membership stays in the role grants at base, read through one function, the way ws-067 reads the core classes, and #2534's move of roles into the declaration moves every class at once. Reading a path pin at base keeps ws-067's rule that a change can't widen its own scope. An unknown key fails closed because nothing says who is in that class, and only a writer judged human could be; a writer in a core or known class is judged by that class, which comes first. #3163 builds on classesOf: a gate or a person-attributed record asks whether a forge identity or signer principal is in a declared class, and requires attested provenance from it."
rejected:
  - option: "b"
    why: "Older chants would refuse the whole kinds file of a plugin that lists a class."
  - option: "c"
    why: "D5 gives domain classes to plugins; a per-workspace list repeats a domain's vocabulary and lets one name mean two things."
  - option: "d"
    why: "A missing plugin would silently widen a restricted class's writes to human's."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3080, write scope: principal classes a plugin defines"
    url: "https://github.com/INTENTIUS/chant/issues/3080"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#3163, person-attributed records and gates rest on forge identities or signer keys"
    url: "https://github.com/INTENTIUS/chant/issues/3163"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#738, approvals and verdicts rest on a forge identity or signer key"
    url: "https://github.com/arugula-salad/hud/issues/738"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-067, write scope and agent sessions"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-067-write-scope-and-agent-sessions.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-031, plugin shape"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-031-plugin-shape.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3080"
  - "INTENTIUS/chant#3163"
  - "arugula-salad/hud#738"
  - "ws-067"
  - "path:packages/core/src/workspace/principal-classes.ts"
  - "path:packages/core/src/workspace/write-scope.ts"
---

# Principal classes from plugins

The `./workspace-principals` file is described in [Workspace Kinds](https://intentius.io/chant/reference/workspace-kinds/#principal-classes-from-a-package), and how `writeScope` names a domain class in [Workspace Declaration](https://intentius.io/chant/reference/workspace-declaration/#write-scope-and-agent-sessions).
