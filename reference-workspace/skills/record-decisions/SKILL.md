---
name: record-decisions
description: Record a session's decisions as chant decision records, by hand, in whatever harness you're in.
---

# Record decisions from this session

Use this when someone asks you to record, write down or capture the decisions
from the current session (or a specific stretch of it). It works the same way
in Claude Code, Codex, Gemini CLI, opencode, or any other harness that can run
shell commands: everything here is plain `chant` commands and JSON on stdin.

A decision record is chant's shape for a choice between options, made for a
stated reason: `docs/design/decisions/README.md` in the chant repo describes
the format in full. This skill only covers proposing new ones from a session,
not reviewing or deciding them.

## 1. Find the decision kind

Decision records live beside their kind file, usually
`decisions/decision.kind.mjs` at the workspace root (this workspace's copy is
right next to this skill, one level up). If you're not sure, check
`chant.workspace.json`'s top-level `records` list, or run:

```bash
chant workspace ls --json
```

Every command below names the kind file explicitly, so it works from any
directory and never guesses.

## 2. List the session's decisions

Read back through the conversation and the diff or commits it produced. For
each point where the session picked one option over others for a stated
reason, write down:

- a short title and a one-sentence question ("What logs the app's errors?")
- every option that was on the table, including the one not picked, each with
  how it would have worked and its tradeoff
- the option chosen, and the reason
- what the decision touches: files, workspace members, or an issue

Drop anything that wasn't really a choice: a one-way task, a typo fix, or
applying a rule someone else already decided isn't a decision. If nothing in
the session meets this bar, say so and stop; recording nothing is a valid
outcome.

## 3. Check for duplicates and contests

Read the workspace's current decisions:

```bash
chant workspace records --kind decisions/decision.kind.mjs --current --json
```

For each candidate from step 2, compare its title and question against the
records this prints:

- same topic, same conclusion: it's a **duplicate**. Drop it; don't write it
  again.
- same topic, a different conclusion: it **contests** the existing record.
  Keep the candidate, but say so plainly when you show the list, and name the
  record it contests (its `id`).
- no match: it's new.

## 4. Show the list, then write only what's kept

Show the person every candidate that survived step 3, marked as new or
contesting, with the duplicates you dropped named too so they can object.
Write only the ones they keep.

Each one is written as a `proposed` record, never `decided`: nobody but a
person (or a later review) moves a decision to `decided`. Build its fields as
JSON. This is a complete example, a decision a session about the app's
logging might produce:

<!-- example-record: checked against the decision schema by test/reference-workspace.test.ts -->
```json
{
  "schema": 1,
  "id": "ref-003",
  "title": "Where request logs go",
  "state": "proposed",
  "area": "app",
  "source": { "kind": "workspace", "member": "app", "session": null },
  "question": "Where does the app write its structured request logs?",
  "options": [
    {
      "id": "a",
      "label": "stdout, newline-delimited JSON",
      "how": "The server writes one JSON object per request to stdout; the platform's log collector picks it up.",
      "tradeoff": "No extra dependency, and it matches how delivery already runs the container. Nothing rotates or ships it on its own."
    },
    {
      "id": "b",
      "label": "a local log file",
      "how": "The server appends to app.log next to its source.",
      "tradeoff": "Works offline and is easy to tail by hand. Needs rotation, and the platform's log collector never sees it."
    }
  ],
  "choice": null,
  "rejected": [],
  "supersedes": [],
  "evidence": [],
  "decided_by": null,
  "decided_on": null,
  "reviews": [],
  "constrains": ["member:app"]
}
```

Pipe it to `records new` on stdin, the object above between the heredoc
markers:

```bash
chant workspace records new decisions/decision.kind.mjs --from - <<'JSON'
{ "schema": 1, "title": "Where request logs go", "state": "proposed", ... }
JSON
```

The example above names its own `id` so it stands on its own; in practice,
leave `id` out and let `records new` pick the next one (`ref-003` after
`ref-002`, and so on). It refuses an id already in use. The command prints
what it wrote:

```json
{
  "path": "decisions/ref-003-where-request-logs-go.md",
  "id": "ref-003",
  "dryRun": false,
  "warnings": [
    { "code": "record-no-evidence", "message": "evidence is empty: the record cites nothing and pins no file" }
  ]
}
```

Tell the person the path and id it wrote, and read out any warnings, such as
`record-no-evidence` above; a proposed record with no evidence yet is normal,
and the warning is a reminder for whoever reviews it, not a failure. Pass
`--dry-run` first if you want to see the file's text without writing it.

Field notes:

| Field | What to put in it |
|---|---|
| `state` | Always `"proposed"` here. `choice` must be `null` while it is. |
| `source` | Where the decision was made. With no issue behind it, use `{"kind": "workspace", "member": "<member-name>", "session": null}`, naming the workspace member the decision concerns. If the session was working an open issue, use `{"issue": "owner/repo#123", "row": "<title>", "revision": null}` instead. |
| `area` | The rough section or topic, such as `"app"` or `"delivery"`. Use `null` if nothing fits yet. |
| `decided_by`, `decided_on` | Leave both `null`. Nobody has decided yet: that happens later, in a review, with `records amend <id> --set - <<< '{"state": "decided", "decided_by": "<name>", "decided_on": "YYYY-MM-DD", "choice": {...}}'`. This skill doesn't take that step. |
| `evidence` | Links or pinned workspace files backing the decision, if you have them. `[]` is fine for a quick capture. |
| `constrains` | At least one entry: `member:<name>` for a workspace member, `path:<path>` for a specific file, a decision id, or `owner/repo#123` for an issue. |
| `rejected` | The options not chosen, each with why, if you know it. `[]` is fine if you only captured the winning option. |

`records new` has no `--by` flag; there's nothing to name. Chant's own
provenance comes from the git commit that adds the file, once it's committed:
that's who chant already shows as having proposed the record, without you
setting anything.

## 5. A pinned transcript, once your chant has it

The `source` field above only says where the decision was made, not which
harness or model proposed it. [#2708](https://github.com/INTENTIUS/chant/issues/2708)
adds that: which harness, model and session proposed a record, with a hash of
the transcript it came from, so a later reader can tell the transcript they
hold is the one meant. Once your chant writes it, fill it in from your
harness's own session info; until then, skip it, and the record's only
provenance is the git commit that adds it.

## 6. Prefer the MCP tool when your chant serves it

[#2707](https://github.com/INTENTIUS/chant/issues/2707) adds a `records-new`
MCP tool that does the same write as step 4, over MCP instead of a shell, and
fills in who proposed it (the MCP client) automatically. If your harness is
connected to `chant serve mcp` and it lists `records-new`, use it instead of
the CLI command in step 4; the fields are the same. If it doesn't, or you're
not sure, the CLI command works everywhere and is the one to fall back on.
