---
schema: 1
id: "ws-092"
title: "Following a squash merge"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3035"
  row: "Follow a squash merge to the pull request's original commits"
  revision: null
question: "How does a read learn which original commits a squash merge folded, so that the squash joins the runs and work those commits carried, without reaching the network on every read, and when does it follow?"
options:
  - id: "a"
    label: "follow when asked, from the forge's pull request ref, fetched once and kept in the clone"
    how: "graph --intent, graph --intent --record and workspace runs take --follow-squash. A commit whose subject ends with (#<n>), with one parent and whose pull request head is not in its history, is a squash. The read takes the head from refs/chant/pull/<n>/head, refs/pull/<n>/head or refs/remotes/origin/pr/<n>, whichever the clone has, and fetches the missing ones from origin in one fetch into refs/chant/pull/<n>/head, where the next read finds them. GitHub and Forgejo both keep refs/pull/<n>/head; the forge is named from origin's URL. The original commits are the head's commits the squash's parent lacks. The squash commit lists them with their trailers, joins and signatures, carries the records and lease items their trailers name and the units their plugin joins give, and joins their runs with joinedBy squash and via naming the originals. why narrows a squash line to the original that wrote it by git blame at the head when the file there is the squash's. A ref that can't be read or fetched is the reason squash-unfollowed, never a failure. Without the flag nothing is fetched or followed."
    tradeoff: "The forge already keeps the mapping, so chant writes nothing and every squash ever made can be followed, including ones merged in the forge's web page with no chant step. The first follow of a pull request needs the network and the forge's read access; later ones read the clone. A forge that drops its pull refs, or one chant doesn't know with other ref names, gives squash-unfollowed. A subject edited to drop (#<n>) is not recognised."
  - id: "b"
    label: "follow by default"
    how: "As a, with following on for every read, and --no-follow-squash to turn it off."
    tradeoff: "Complete answers on repositories that squash. Every read that meets an unfetched squash reaches the network, so reads are slower and fail closed into squash-unfollowed on a box with no egress to the forge, which studio's app template lacks (studio-032)."
  - id: "c"
    label: "a squash map written at merge time"
    how: "Whatever merges a pull request, such as studio's Apply, appends <squash sha> to <original shas> to a ledger on chant/lifecycle through a chant command, and reads join through it with no network."
    tradeoff: "No network on any read. Only merges made through that command are mapped: a squash done in the forge's web page, by a person or a bot, is missing, and every merger has to call chant after the forge has made the commit. The map is a second copy of what the forge's ref already holds, and ws-075 keeps no copy that can disagree with the commit it describes."
  - id: "d"
    label: "read the original messages from the squash's body"
    how: "GitHub's squash body can hold every original commit's message, trailers included; chant parses Chant-Run and Chant-Record lines out of the body."
    tradeoff: "No network and no map. It depends on the repository's squash message setting, a person can edit the body before merging, the originals' SHAs and signatures are not there, and the lines are not trailers git parses, so chant would need its own parser for them."
choice:
  option: "a"
  reason: "studio-032 b already decided that hud follows squashes only when asked, and studio-029 b makes box pull requests merge with a merge commit, so following is the exception and a read should not pay for it by default. The forge's pull request ref is the one place that keeps every squash's originals whoever merged it, so reading it needs no new writer and nothing that can disagree with it. Keeping a fetched ref under refs/chant/pull/ makes the network a one-time cost per pull request, and a ref that can't be had is reported the way the walk reports any part it can't read."
rejected:
  - option: "b"
    why: "It puts the forge on the path of every read, which studio-032 rejected for hud, for squashes studio-029 b avoids."
  - option: "c"
    why: "It maps only the merges made through one command and duplicates what the forge's ref holds."
  - option: "d"
    why: "The body is free text a setting or a person changes, and it keeps neither the SHAs nor the signatures."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3035, follow a squash merge to the pull request's original commits"
    url: "https://github.com/INTENTIUS/chant/issues/3035"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#280, how Apply's pull requests merge so provenance survives (studio-029, studio-032)"
    url: "https://github.com/arugula-salad/studio/issues/280"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#700, why is it like this, from a line or symbol"
    url: "https://github.com/arugula-salad/hud/issues/700"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-075, chant's commit trailers"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-075-commit-trailers.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-078, from a line or symbol to the decision and the agent run behind it"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-078-from-a-line-or-symbol-to-the-decision-and-run.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3035"
  - "arugula-salad/hud#700"
  - "ws-075"
  - "ws-076"
  - "ws-078"
  - "path:packages/core/src/workspace/squash.ts"
---

# Following a squash merge

`--follow-squash` on `graph --intent`, `graph --intent --record` and `workspace runs` follows a squash merge to its pull request's original commits through the forge's `refs/pull/<n>/head`, fetched from `origin` the first time and kept under `refs/chant/pull/<n>/head`. The squash commit then lists the originals with their trailers, joins and signatures, carries what they carry and joins their runs, marked `squash`. Without the flag a read neither fetches nor follows, as studio-032 b chose for hud.
