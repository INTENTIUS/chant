---
schema: 1
id: "ws-059"
title: "Graph cache"
state: "decided"
area: "D8"
source:
  issue: "INTENTIUS/chant#2876"
  row: "Graph cache"
  revision: null
question: "ws-018 made chant the composer for declared workspaces and said behold's per-member cache would move with it. Who keeps a member's graph between reads, and what says a member changed?"
options:
  - id: "a"
    label: "chant caches"
    how: "`chant workspace graph` keeps each member's source read on disk in the user's cache directory (`$CHANT_CACHE_DIR`, else `$XDG_CACHE_HOME/chant`, else `~/.cache/chant`), never in the workspace, keyed on the member's stamp, its toolchain, its command line and the environment. A member whose key still matches is served without starting its chant. Each member entry says `cached` and carries its `stamp`, and `--no-cache` reads every member."
    tradeoff: "Every reader gets warm reads, and the CLI gets them across processes. chant keeps state on disk and owns the rule for when a stored read may be served."
  - id: "b"
    label: "chant stamps, readers cache"
    how: "chant keeps nothing. Each member entry carries a stamp computed the same way, and a reader rereads with `--member` only the members whose stamp moved, splicing them into the document it holds."
    tradeoff: "chant stays stateless. Every reader carries its own cache and splice, and `links` and `groups`, which span members, have to be recomputed by the reader without rereading."
choice:
  option: "a"
  reason: "Composition spans members, so a splice in the reader would repeat the composer ws-018 moved into chant. One cache in chant serves behold, hud and the CLI alike, across processes. It is keyed on what a read takes in rather than on how the member is read, so a member read through a generated reader project caches by its own directory's stamp."
rejected:
  - option: "b"
    why: "Every reader would carry a cache and a splice of links and groups. That is the per-reader composer ws-018 set out to remove."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2876, workspace graph reruns every member on every call"
    url: "https://github.com/INTENTIUS/chant/issues/2876"
    as_of: "2026-09-26T22:00:00Z"
  - title: "INTENTIUS/chant#2481, chant costs about 800 ms per invocation before it does any work"
    url: "https://github.com/INTENTIUS/chant/issues/2481"
    as_of: "2026-09-26T22:00:00Z"
  - title: "behold's per-member cache and its invalidation rule (src/member-ir.ts, INTENTIUS/behold#307)"
    url: "https://github.com/INTENTIUS/behold/blob/main/src/member-ir.ts"
    as_of: "2026-09-26T22:00:00Z"
  - title: "ws-018, Composer"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-018-composer.md"
    as_of: "2026-09-26T22:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-26"
reviews: []
constrains:
  - "INTENTIUS/chant#2876"
  - "INTENTIUS/behold#464"
---

# Graph cache

## The key

A stored read is served only when all of these match:

- The member's command line is a source read. One holding `--live`, `--overlay` or `--traffic` observes an account and is never cached or stamped.
- The member's stamp. For the working tree it covers every regular file under the member's directory by path, mtime and size, leaving out `node_modules`, `dist`, `.git`, every dot-directory, and, for member `.`, the other members' directories. It also covers the install files found from the member's directory up to the file-system root: `node_modules/.package-lock.json` and the lockfiles. With `--at` the commit id stands in for the files, since a commit's tree never changes, and the install files still count because members run under the toolchain installed now.
- The toolchain: the real path of its `bin/chant`, its package version, and the stamp of its package's `src` when it isn't installed under `node_modules`.
- The member's command line and the environment, less the variables a shell changes on its own.

## What is never stored

A read whose stamp can't be taken, whose stamp moved between the start and the end of the read, or that failed. A working-tree read whose newest file is younger than two seconds is not stored either, since some file systems keep mtimes to the second.

## Where it lives

Outside the workspace. A read never changes the workspace it reads: the reader conformance kit (#2679) fails a read that adds a file, and behold serves directories it must not write into. So the cache sits in the user's cache directory, one directory per workspace, named for the first 16 hex digits of the sha256 of the workspace root's real path.

## Why mtime and size, not content

Hashing content would read every byte of every member on every read. Path, mtime and size are what behold has keyed on since #307, the freshness window covers the coarse-mtime case, and a false miss costs one read while a false hit is what the window exists to prevent.
