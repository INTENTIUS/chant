# Prompt: record this session's decisions

Paste this into any chat-based coding assistant that can run shell commands
but has no skill or slash-command mechanism of its own. It asks the model to
do exactly what `skills/record-decisions/SKILL.md` describes, written out as
one instruction instead of a file the harness loads on its own.

---

Record the decisions made in this session as chant decision records.

1. Find the decision kind file. It's usually `decisions/decision.kind.mjs` at
   the workspace root; check `chant.workspace.json`'s `records` list, or run
   `chant workspace ls --json`, if you're not sure.

2. Read back through this session and list every point where we picked one
   option over others for a stated reason. For each one, write down a short
   title, a one-sentence question, every option that was on the table (not
   just the one we picked) with how it would have worked and its tradeoff,
   the option we picked and why, and what it touches (files, workspace
   members, or an issue). Leave out anything that wasn't really a choice
   between options, such as a one-way task or a typo fix. If nothing in the
   session meets that bar, say so and stop.

3. Run `chant workspace records --kind <kind file> --current --json` and
   compare each candidate's title and question against what it prints. Mark
   a candidate a duplicate if an existing record already says the same
   thing, and drop it. Mark one a contest if an existing record reaches the
   opposite conclusion on the same topic, and name which record it contests.

4. Show me the list: new candidates, contested ones with what they contest,
   and duplicates you're dropping. Wait for me to say which to keep.

5. For each one I keep, write it as a `proposed` record (never `decided`) by
   piping its fields as JSON to
   `chant workspace records new <kind file> --from -`. Required fields:
   `schema: 1`, `title`, `state: "proposed"`, `area` (or `null`), `source`,
   `question`, `options` (every option, each with `id`, `label`, `how`,
   `tradeoff`), `choice: null`, `rejected: []` (or with reasons, if you have
   them), `supersedes: []`, `evidence: []` (or links/pins, if you have
   them), `decided_by: null`, `decided_on: null`, `reviews: []`, and
   `constrains` with at least one entry (`member:<name>`, `path:<path>`, a
   decision id, or an issue ref). Leave `id` out so chant assigns the next
   one.

   `source` says where the decision was made: `{"kind": "workspace",
   "member": "<name>"}` with no issue behind it, or `{"issue":
   "owner/repo#n", "row": "<title>", "revision": null}` when there is one.
   Add to that same object, if you know them: `via: "cli"` (you're using the
   shell command), `harness` (your own id, such as `"claude-code"`,
   `"codex"`, `"gemini-cli"` or `"opencode"`), `model` (the model id you're
   running as), `session` (your harness's session or conversation id), and
   `transcript` (`{"path": "<file>", "sha256": "<hex>"}`, pinning your
   session transcript by the hash of its bytes, never its content). All of
   these are optional; leave out what you don't know.

   Tell me the path and id it wrote, and read out any warnings.

If the workspace's chant serves an MCP `records-new` tool
([#2707](https://github.com/INTENTIUS/chant/issues/2707)), use it instead of
the shell command in step 5; same fields, minus `via` and `client`, which it
fills in itself from the MCP client's own `clientInfo`.
