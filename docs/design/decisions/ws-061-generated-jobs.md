---
schema: 1
id: "ws-061"
title: "Generated files and job names on ls"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3050"
  row: "Generated files and job names on ls"
  revision: null
question: "A forge-side reader such as github-warden requires a member pipeline's jobs as status checks, and no contract document lists them. Where does the read contract publish a member's generated files and their job names, and how does it find them?"
options:
  - id: "a"
    label: "On ls, from the declaration and the record"
    how: "Each `members[]` entry of `ls --json` gains `generated: [{ path, command, env, jobs }]`. It merges the member's declared generated entries with the interim `.chant/generated.json` record, with paths from the repository root, and `jobs` holds the check names parsed from a forge CI file."
    tradeoff: "One command answers it and `--at` works, since both sources and the CI file are read from the tree. chant parses CI YAML for names, which is read-only and runs nothing."
  - id: "b"
    label: "A new command or a status field"
    how: "A separate `chant workspace pipelines --json`, or the field on `status`."
    tradeoff: "Keeps `ls` small, and `status` has no `--at` and needs an environment. A reader would run one more command for data that is a property of the member, not of a release."
choice:
  option: "a"
  reason: "The files and their names are properties of the member and its tree, like its records and diagrams, which `ls` already carries. `ls` reads at a revision and needs no environment."
rejected:
  - option: "b"
    why: "It needs a new schema and command, and `status` can't read a revision."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3050, job names are in no contract document"
    url: "https://github.com/INTENTIUS/chant/issues/3050"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/github-warden#62, required checks per member pipeline"
    url: "https://github.com/INTENTIUS/github-warden/issues/62"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#3050"
---

# Generated files and job names on ls

## The name of a job

The check name a forge shows. For GitHub, Forgejo and Gitea it is the job's `name`, else its id. For GitLab it is the job's key, leaving out hidden jobs (a leading `.`) and the keywords that are not jobs. A matrix expands to more names on the forge and is not expanded here. A file that is missing or can't be parsed has `jobs: null`, so a reader tells "no jobs" (`[]`) from "unknown".

## Paths

From the repository root, because a forge reads CI files from fixed paths there. A declared entry is relative to its member's directory and is joined onto the member's directory and the workspace root. The interim record already holds repository paths. A path in both sources lists once, with the declared entry's command.

## Contract version

An added field within contract 1, like `records` and `diagrams`. A reader ignores fields it doesn't know.
