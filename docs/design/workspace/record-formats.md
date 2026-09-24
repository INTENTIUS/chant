# Record formats beyond markdown front matter

The design note behind [ws-053](../decisions/ws-053-record-formats.md), for [#2664](https://github.com/INTENTIUS/chant/issues/2664) under [#2546](https://github.com/INTENTIUS/chant/issues/2546). The decision is `proposed`: it records the options and a recommendation, and its `choice` stays null until the maintainer decides.

## What the reader does today

`packages/core/src/workspace/records.ts` reads one kind at a time. The kind file exports `recordKind`, which is data: a `location` (one directory and a file-name pattern, no subdirectories), `format: "markdown-front-matter"` and nothing else, a schema by `$id` and path, an `idField`, a `stateField` with its `states` and `closedStates`, a required `supersedes: {field, key}` whose field is a list of objects, and optional `approval` ranks, `pins` and `constrains`. The reader parses the front matter as the JSON subset of YAML, validates it with ajv, and derives duplicate ids, supersession under an equal or stricter approval rule, and the pin states `pinned`, `drifted`, `missing` and `stale` against the tree read. Everything else, the decision's `source` forms and the rule that a dissent needs a note included, is the kind's schema acting on `data`.

`records.schema.json` is contract 1 of the read contract. `READ_CONTRACT_FLOOR` is 0.81.0, and `reason-codes.ts` says a code added after the floor means a new contract version. Every option below is judged partly by whether it needs one.

chud's records, from section 1 of its [research for #78](https://github.com/jhgaylor/chud/blob/9ce13a218b2f92d2f9a3af4ea6fc3d834d795bc9/docs/research/78-records-and-dispatch-as-a-chant-plugin.md):

| chud kind | File | Id | State | Supersedes | What stops a chant kind today |
|---|---|---|---|---|---|
| unit | `units/U-NNNN.json` | `id` | `outcome`: open, done, not_done | none (`corrects` is a different relation) | JSON; `supersedes` required |
| evidence | `evidence/<sha256>.json`, named by the hash of its bytes | the file name | none | none | JSON; no id field; no state; `supersedes` required |
| session | `sessions/S-NNNN.json` | `id` | `status`: open, closed | none | JSON; `supersedes` required |
| driver closure | `drivers/closures/D-NNN.json` | `driver` | none | none | JSON; no state; `supersedes` required |
| contract | `contracts/C-NNN*.md` | `id` | `status`: draft, approved, retired | one id, `supersedes: "C-001"` | `supersedes` must be a list of objects |
| driver | `drivers/D-NNN*.md`, or `drivers/D-NNN/design.html` | `id` | `status`: open, closed | none | `supersedes` required; the HTML form is in a subdirectory with its core in a `<script type="application/json">` |

Every chud schema is draft-07 and `$ref`s `defs.schema.json`, which the reader cannot resolve because it compiles one schema file alone.

## The options

### (a) `format: "json"` on the kind file

| Aspect | Effect |
|---|---|
| `records.ts` | `recordKindSchema.format` becomes an enum of `markdown-front-matter` and `json`. A `json` file is parsed with `JSON.parse`, refused unless its top-level value is an object, and refused when a member name repeats (RFC 7493), which needs a check of its own because `JSON.parse` keeps the last value silently. The existing `nonJson` walk still runs. Failures are `record-unparseable`. |
| `records.schema.json` | No new code. `data` is described as the record's structured core, the front matter or the whole JSON document. `kind` may gain an optional `format`, a field added within contract 1. |
| Read-contract consumers | The same entries. A reader that only knows decisions sees nothing new. |
| Level 0 | Nothing. `records.ts` loads only under `chant workspace`, and `JSON.parse` needs no dependency. |
| `supersedes` | Unchanged, and still required, so a JSON kind must carry a list-of-objects field it may not have. |
| Pins | Unchanged: `pins.field` is read from the parsed object. |
| `source`, reviews | Unchanged: both are schema rules on `data`, whatever the file format. |
| Intent graph | Unchanged. It treats every record kind given with `--kind` as a source of decision nodes joined by `constrains`, and a JSON kind with no `constrains` field contributes no node. |
| chud gains | Nothing yet on its own: units, sessions and closures still fail the required `supersedes`, and evidence has no id. |

### (b) Several directories or a glob

| Aspect | Effect |
|---|---|
| `records.ts` | `location` takes `dirs: []` or `glob` in place of `dir`; the match applies to paths below each. `RecordSource.list` gains a recursive form: `readdir` walks in the working tree, `git ls-tree -r` under `--at`. `glob.ts` (ws-051) walks directories, not files, so it would need a file form. |
| `records.schema.json` | No change: paths are already from the repository root. |
| Read-contract consumers | The same entries, from more places. |
| Level 0 | Nothing. |
| `supersedes`, pins, `source`, reviews | Unchanged. Duplicate ids are found across every matched directory in path order. |
| Intent graph | Unchanged. |
| chud gains | Only `drivers/D-NNN/design.html`, and only with an HTML core format that extracts the `<script type="application/json">` core and refuses a second one, as ws-003 requires of any in-file extractor. Driver closures are already a kind of their own in `drivers/closures/`. |

### (c) A content-addressed id rule

| Aspect | Effect |
|---|---|
| `records.ts` | `idFrom: "sha256"` is accepted in place of `idField`. `RecordSource` gains `bytes(path)`; the git source keeps each blob as a `Buffer` rather than decoding it to text. The id is the lowercase hex SHA-256 of the file's bytes, computed as `record-assets.ts` computes a pin. The name's stem (the name up to its first `.`) is the hash the name claims. When it differs, the record gets an entry in `assets` for its own path with `sha256` set to the stem, `actual` set to the id and `state: "drifted"`, and the `asset-drift` warning. |
| `records.schema.json` | No new code. The `id` description says a content-addressed kind's id is the hash of the file's bytes, and the `assets` description says a content-addressed record may list itself. |
| Read-contract consumers | An id that is a 64-character hex string, and possibly a self-pin in `assets`. A reader that matches ids as strings needs nothing new. |
| Level 0 | Nothing. |
| `supersedes` | A content-addressed record cannot be edited without becoming a different record, so supersession between two of them is a new record naming the old hash, which works unchanged. chud's evidence never supersedes. |
| Pins | A pin elsewhere, such as a unit citing `{path: "design/evidence/<h>.json", sha256: "<h>"}`, carries the evidence record's id as its `sha256`, so a reader can go from the pin to the record by string equality. A misnamed or edited evidence file shows as drifted on the unit's pin as well as on itself. |
| `source`, reviews | Unchanged. |
| Intent graph | A plugin's `commitJoins` evidence id and the record id are the same string, which issue 5 below uses. |
| Hashing | The id hashes bytes, as pins and `sha256sum` do, not the RFC 8785 JCS form #2524 D4 names for seals. A content-addressed record needs no seal: changing it changes its name. |
| chud gains | Evidence as a record, once the format is JSON. Alone, nothing. |

A new reason code such as `record-content-mismatch` would say the same thing more plainly, and it would make the record invalid as chud's reader does today. After the 0.81.0 floor it would also make the records output contract 2, which every reader would have to accept. The self-pin keeps contract 1, and chud's checks read `warnings` to refuse a drifted evidence record.

### (d) A reader function in the kind file

| Aspect | Effect |
|---|---|
| `records.ts` | A kind with a `readRecords(tree)` export skips parsing; core takes the returned entries and derives ids, supersession and pins over them. `format` becomes optional. |
| `records.schema.json` | Either no change, if core still validates returned data against the kind's schema, or a record's `valid` becomes the plugin's claim. |
| Read-contract consumers | The same shape, with no guarantee that two readers of the same file agree, since the bytes-to-record mapping is plugin code. |
| Level 0 | Nothing. |
| `supersedes`, pins | Derived by core as today, over whatever the function returns. |
| `source`, reviews | Validated only if core keeps validation. |
| Seals and `--at` | A seal (#2546, ws-003) covers the whole file, and the spec query (ws-045) returns records by their core; both rest on a core chant did not extract. `--at` works only when the plugin reads through the tree it is given. |
| chud gains | Everything at once, HTML driver documents included, with its current reader. |

### (e) (a) and (c) together, with state and supersedes optional

(e) is (a) and (c) plus the three loosenings chud's kinds need. `stateField`, `states` and `closedStates` become optional as a group, and a stateless kind's records have `state: null`. `supersedes` becomes optional; `key` becomes optional, and without it the field holds one id or a list of ids. The kind schema refuses `supersedes` on a stateless kind, because a link takes effect only from a closed or ranked state. `schema.refs` lists further schema files, each checked for its own `$id` and added to ajv before the kind's schema compiles. Every row above for (a) and (c) holds, and none of these adds a code or changes what the decision kind prints.

## Recommendation

(e). It is the smallest change that makes each of chud's JSON kinds a kind file with no reader code, and it keeps parsing, validation and ids in core, where seals and the spec query need them. It adds no code to the read contract, so contract 1 and its readers hold, and nothing loads at level 0. (a) and (c) lost only as standalone options. (b) waits until someone proposes an HTML core format, since that is the one layout it would serve. (d) lost because a plugin reader is the second parser that ws-052 rejected for hud, run inside chant.

## chud's kinds under (e)

Written as the kind files chud's model package would ship (research section 4), with paths relative to the kind file in `design/`:

| Kind | `location` | `format` | Id | States | `supersedes` | `pins` |
|---|---|---|---|---|---|---|
| unit | `units`, `^U-\d+\.json$` | `json` | `idField: "id"` | `outcome`: open, done, not_done; closed: done, not_done | none | `evidence`, once new units write `{path, sha256}` entries |
| evidence | `evidence`, `^[0-9a-f]{64}\.json$` | `json` | `idFrom: "sha256"` | none | none | none |
| session | `sessions`, `^S-\d+\.json$` | `json` | `idField: "id"` | `status`: open, closed; closed: closed | none | none |
| driver closure | `drivers/closures`, `^D-\d+\.json$` | `json` | `idField: "driver"` | none | none | none |
| contract | `contracts`, `^C-\d+.*\.md$` | `markdown-front-matter` | `idField: "id"` | `status`: draft, approved, retired, ranked draft 0, approved 1, retired 1 | `{field: "supersedes"}`, no key | none |
| driver | `drivers`, `^D-\d+.*\.md$` | `markdown-front-matter` | `idField: "id"` | `status`: open, closed; closed: closed | none | none |

Two things are chud's to change, not chant's. A unit cites evidence today as a list of bare hashes, and chant's `pins` reads only `{path, sha256}` objects, so new units would write objects and the unit schema would accept both; closed units never change, and their bare hashes pin nothing in chant. And a unit kind that declares `pins` gets `record-no-evidence` on every unit whose list is empty, such as an open one, which says what it should. `drivers/D-NNN/design.html` stays outside chant until (b) and an HTML core format are proposed, and chud's reader keeps it until then.

## Implementation issues

In landing order. Each is usable once it lands, without the ones after it, and none changes what the decision kind prints.

### 1. workspace: a `json` record format

A kind file may say `format: "json"`, and `chant workspace records` reads each located file as one JSON object: parsed with `JSON.parse`, a top-level value other than an object refused, a repeated member name refused as I-JSON requires, and every failure reported as `record-unparseable`. Validation, ids, supersession, pins, `constrains`, `--current`, `--at`, provenance and the intent graph run on the parsed object as they do on front matter. The output's `kind` gains an optional `format`, and `data` is described as the record's structured core. On its own it serves any JSON kind whose records have an id, a state and a `supersedes` list.

Acceptance criteria:
- A fixture kind with `format: "json"` reads a valid record, a record that fails its schema (`record-schema-invalid`), a file that is not JSON, a file whose top level is an array and a file with a repeated key (each `record-unparseable`), in the working tree and under `--at`.
- `records --kind docs/design/decisions/decision.kind.mjs --json` prints the same bytes before and after, apart from the optional `format` field.
- No code is added to `reason-codes.ts`, and the level-0 goldens (#2526) pass unchanged.
- `docs/src/content/docs/cli/workspace-records.mdx` documents the format.

### 2. workspace: record kinds without states or supersession, and a supersedes field of bare ids

`stateField`, `states` and `closedStates` become optional together, and a record of a stateless kind has `state: null`. `supersedes` becomes optional, and its `key` optional: without `key` the field holds one id or a list of ids, as chud's contract `supersedes: "C-001"` does, and each is a link under the same approval rule. The kind schema refuses `supersedes` or `approval` on a kind without states. On its own it makes chud's Markdown contracts and drivers kind files with no change to them.

Acceptance criteria:
- A stateless fixture kind reads with `state: null` on every record, `supersededBy: null`, and valid records.
- A kind whose `supersedes` field is a string id, and one whose field is a list of string ids, derive `supersededBy` under `approval` ranks as the list-of-objects form does, including `record-supersedes-unknown` and `record-supersedes-pending`.
- A kind file with `supersedes` and no `states` is `kind-invalid`, with a message naming the field.
- The decision kind's output is unchanged.

### 3. workspace: a record kind names the schema files its schema references

The kind's `schema` gains `refs`, a list of `{id, path}` for schema files the kind's schema `$ref`s. Each is read, checked for its `$id` as the main schema is (`schema-unreadable`, `schema-id-mismatch`), and added to ajv before the kind's schema compiles. On its own it lets a plugin ship its schemas as they are, such as chud's, which all `$ref` `defs.schema.json`.

Acceptance criteria:
- A fixture kind whose schema `$ref`s a sibling defs file by its `$id` validates records against it.
- A missing refs file is `schema-unreadable` and a wrong `$id` is `schema-id-mismatch`, each naming the file.
- A kind without `refs` behaves as before, and a schema with an unresolved `$ref` is still `schema-invalid`.

### 4. workspace: content-addressed record ids

A kind may declare `idFrom: "sha256"` in place of `idField`. The id of each record is the lowercase hex SHA-256 of the file's bytes, read through a new `bytes` on `RecordSource` (the git source keeps blobs as bytes). A file whose name stem differs from its id is listed in its own `assets`, by its path from the workspace root, as `drifted`, with `sha256` the stem and `actual` the id, and gets the `asset-drift` warning, so no reason code is added. On its own, with issue 1, it makes chud's evidence a kind file.

Acceptance criteria:
- A fixture evidence kind reads a record whose id equals `sha256sum` of the file, in the working tree and under `--at`.
- Editing a byte of that file leaves the record valid, changes its id, and reports its self-pin as `drifted` with `asset-drift`; a record in another kind pinning the old `{path, sha256}` reports `drifted` too.
- A kind file with both `idField` and `idFrom`, or neither, is `kind-invalid`.
- `records.schema.json` documents the id and the self-pin, and no code is added to `reason-codes.ts`.

### 5. workspace: the intent graph links a plugin's unit, contract and evidence to records it read

When `graph --intent` is given a record kind and a `commitJoins` kind together, and a joined unit, contract or evidence may name a record as `record: "<kind>/<id>"`, the graph adds that record's node (its validity, state, provenance and assets as `records` reports them) and gives the joined node a `record` field holding the node's id. A joined node that names no record, or a record no kind read, is unchanged. With issue 4, chud's evidence joins by its hash, the same string the unit pins. On its own it serves any plugin whose units or contracts are records of a kind it ships.

Acceptance criteria:
- On a fixture with a unit kind, an evidence kind and a `commitJoins` returning `record` references, the intent document lists the unit and evidence records and links each joined node to its record node.
- A reference to a record that no kind read produces the joined node alone, with no `record` field and no failure.
- `intent.schema.json` documents the optional `record` field within contract 1, and no finding code is added.

## Out of scope

HTML driver documents (`drivers/D-NNN/design.html`), which need (b) and an HTML core format. Context bundles (`design/context/<sha256>.json`), which ws-052 gives to the plugin; with issues 1 and 4 they could be a content-addressed kind as well, if chud wants chant to read them. Decision-point answers on the `chud/decisions` branch, which need a location on another ref (#2524 D4). Seals, which #2546 still plans.
