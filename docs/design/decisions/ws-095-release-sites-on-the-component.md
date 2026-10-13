---
schema: 1
id: "ws-095"
title: "Release sites on the component"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#3153"
  row: "delivery config: move studio's chant.config keys (protectedPaths, sites, decisions.issue, signing key) into the spec"
  revision: null
question: "Where do the facts studio keeps under a studio key in delivery's chant.config.ts go: the paths a build may not change, the sites a release ships to (local, or a Fly app with its lifecycle remote, URL and custom domain), the tracking issue given to chant init, and the release signing key?"
options:
  - id: "a"
    label: "sites as environments on the release component; protected paths in writeScope; the issue dropped; the signing key left in chant's own signing config"
    how: "The component contract gains environments: a list of { name, runtime, url, domain, lifecycle }, each optional but the name, saying where a release of the component goes in that environment. chant graph --components carries them, and chant workspace graph --composites gives every environment the component declares a site { runtime, url, domain, lifecycle }, adds a name only the component declares with source component when chant run --env takes it, and leaves one the config's environments don't cover out with environments-component-undeclared. The command runs on the site's runtime when the member hosts it. protectedPaths is writeScope.<class>.protected, which ws-077 already added. decisions.issue is dropped: the template parameter is recorded in the lineage lock's parameters, and nothing reads the key. signing.key is chant's own signing config (#622), not a studio key, and stays."
    tradeoff: "The release Op reads its sites from the component it imports, and hud's deploy button reads the same sites from graph --composites, so studio's config has no key of its own. A site belongs to one component, so a member with two components that ship to different places says so per component. The config's environments still decide which names chant run --env accepts, so a site is declared in two places when the config lists its environments."
  - id: "b"
    label: "site fields on chant.config.ts environments"
    how: "An environment entry, which already takes { name, endpoint }, gains runtime, url, domain and lifecycle."
    tradeoff: "One place per member, beside the names chant run --env accepts. Every component of the member shares the sites, a reader needs the member's config loaded to see them, and the issue's direction (#2695) is the release component's environments."
  - id: "c"
    label: "an environments block per member in chant.workspace.json"
    how: "A member entry lists its environments and sites in the declaration, read without loading any config."
    tradeoff: "The read contract has it without running a member. Where a member's components ship is the member's own configuration, not the workspace's, and it would sit apart from the code that ships there."
  - id: "d"
    label: "name the release key through the workspace signers"
    how: "signing.key names a signer or runner key from .chant/allowed_signers or .chant/trust.json instead of a path."
    tradeoff: "One trust root. Those keys are ssh-ed25519 keys for attestations and runner evidence (ws-069), and the release is signed with cosign over a PEM or KMS key, so the signer level has no key of the kind a release needs."
choice:
  option: "a"
  reason: "#3145 moves what studio relies on into the spec, and the component is where a release is described: its deploy already names what ships, so where it ships belongs beside it, and graph --composites already lists each component's environments for a deploy button (#2695). A site per component keeps two components of one member apart. Protected paths are done by ws-077. The issue key has no reader and its value is already in the lineage lock. The signing key is chant's own key-based signing override, written under chant's signing key, not studio's, and ws-069's keys can't sign a release archive, so moving it would change what signs, not where it is configured; the issue is re-scoped to leave it."
rejected:
  - option: "b"
    why: "Every component of a member would share the sites, and the issue asks for the release component's environments."
  - option: "c"
    why: "Where a member's components ship is the member's configuration, beside the code that ships them."
  - option: "d"
    why: "The signer level's keys are ssh keys for attestations; a release is signed with cosign keys."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3153, delivery config: studio's chant.config keys into the spec"
    url: "https://github.com/INTENTIUS/chant/issues/3153"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#2695, graph --composites lists each component's environments"
    url: "https://github.com/INTENTIUS/chant/issues/2695"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#287, the factory reads and writes only through chant"
    url: "https://github.com/arugula-salad/studio/issues/287"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-069, signer rotation and runner keys"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-069-signer-rotation-runner-keys.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3145"
  - "arugula-salad/studio#287"
  - "ws-077"
---

# Release sites on the component
