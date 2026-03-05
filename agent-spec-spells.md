# Agent Spells

Agent orchestration for Chant. Spells are TypeScript definitions for operational and development tasks. Git trailers associate commits. Interactive and serial — one agent, one task at a time.

## What Spells Are

Task definitions with context. "Deploy this stack," "add auth to the API," "run migrations," "refactor the router." Define what needs doing, give the agent live context, let it work through the tasks. Disposable after completion. Optionally scoped to a lexicon, but general software projects use spells too.

## User Experience

### Developer (no lexicons)

A developer building a web API. Uses chant to orchestrate agent work. No infrastructure.

```bash
chant spell add user-auth
```

Edit `spells/user-auth.spell.ts`:

```typescript
import { spell, task, file } from "@intentius/core";

export default spell({
  name: "user-auth",
  overview: "Add JWT-based authentication to the API",
  context: [
    "Must support both cookie and bearer token auth",
    "Session expiry: 24 hours",
    "Must not break existing public endpoints",
    file("docs/api-conventions.md"),
  ],
  tasks: [
    task("Create JWT signing and verification module"),
    task("Add auth middleware to Express router"),
    task("Create login and refresh token endpoints"),
    task("Add protected route decorator"),
  ],
});
```

```bash
# See what's ready for work
chant spell list --ready
# → user-auth   ready   [0/4]   Add JWT-based authentication

# Generate bootstrap prompt — context items resolved, fed to agent
chant spell cast user-auth
# Agent works through tasks, uses `chant spell done` to mark completion, commits with trailers
# If interrupted — tasks already marked done are committed. Resume later.

# Mark a task done (agent does this via CLI, not raw text editing)
chant spell done user-auth 1
# → ✓ Task 1 marked done: "Create JWT signing and verification module"

# Check progress after stopping
chant spell show user-auth
# → ready [2/4] — two tasks done, two remaining. Run cast again to continue.
```

### DevOps engineer (with lexicons)

An engineer managing AWS infrastructure with chant lexicons.

```bash
chant spell add deploy-staging
```

Edit `spells/deploy-staging.spell.ts`:

```typescript
import { spell, task, file, cmd } from "@intentius/core";

export default spell({
  name: "deploy-staging",
  lexicon: "aws",
  overview: "Deploy current infrastructure to staging",
  context: [
    "Never deploy during business hours (9am-5pm EST)",
    file("docs/deploy-checklist.md"),
    cmd("chant state show staging aws"),
  ],
  tasks: [
    task("Build and validate CloudFormation templates"),
    task("Apply changeset to staging stack"),
    task("Verify stack outputs"),
  ],
  afterAll: ["chant state snapshot staging"],
});
```

```bash
# Bootstrap prompt includes resolved context (file contents, command output)
chant spell cast deploy-staging

chant spell list
# → deploy-staging   done   [3/3]   aws   Deploy to staging

# Spell is done. Remove the file — git history preserves the definition.
chant spell rm deploy-staging
```

### Team with dependencies

```bash
chant spell list
# NAME             STATUS   TASKS   LEXICON   OVERVIEW
# build-vpc        done     [4/4]   aws       Build multi-AZ VPC
# deploy-aws       ready    [0/2]   aws       Deploy AWS infrastructure
# deploy-k8s       blocked  [0/3]   k8s       Deploy Kubernetes workloads

chant graph
# build-vpc → deploy-aws
# deploy-aws → deploy-k8s
```

---

## Spell Structure

A spell is a TypeScript file in the `spells/` directory at the git root. Identity comes from the explicit `name` field.

```typescript
// spells/deploy-aws-prod.spell.ts
import { spell, task, file, cmd } from "@intentius/core";

export default spell({
  name: "deploy-aws-prod",
  lexicon: "aws",
  overview: "Deploy current infrastructure to production",
  context: [
    "Requires approval from #infra-review before applying",
    file("docs/prod-deploy-runbook.md"),
    cmd("chant state show prod aws"),
  ],
  depends: ["build-vpc"],
  tasks: [
    task("Build and validate CloudFormation templates"),
    task("Apply changeset to production stack"),
    task("Verify stack outputs"),
  ],
  afterAll: ["chant state snapshot prod"],
});
```

`afterAll` commands are included in the bootstrap prompt as post-completion instructions. Still agent-driven execution — no orchestration engine. The agent runs them after marking the last task done.

## Context

Context items are resolved at `chant spell cast` time to assemble the bootstrap prompt. Three types:

| Type | Factory | Resolved to |
|------|---------|-------------|
| Static string | (none) | Included as-is |
| File reference | `file(path)` | File contents inlined |
| Command output | `cmd(command)` | Command stdout inlined |

```typescript
context: [
  "Budget ceiling: $500/month",           // static constraint
  file("docs/deploy-checklist.md"),        // file inlined at work time
  cmd("chant state show staging aws"),     // command output inlined at work time
]
```

File paths are relative to the git root. Commands are executed via `getRuntime().spawn()`.

If `lexicon` is set, the bootstrap prompt automatically includes relevant operational guidance from that lexicon's skills. No need to reference it explicitly.

Resolution errors (missing file, command failure) are warnings in the prompt, not fatal errors. The agent sees: `"[Context error: docs/missing.md not found]"`.

### Bootstrap Prompt Template

The prompt structure is configurable via `chant.config.ts`:

```typescript
export default {
  // ... existing config ...
  bootstrap?: {
    template?: string;    // path to custom prompt template (relative to git root)
  },
};
```

Default template is hardcoded in core. Custom templates receive the same resolved data (overview, context, tasks, lexicon skill, afterAll) and can reorder or reformat sections. Most users won't need this.

## Types

```typescript
interface ContextItem {
  type: "file" | "cmd";
  value: string;
}

interface Task {
  description: string;
  done: boolean;
}

type Status = "blocked" | "ready" | "done";

interface SpellDefinition {
  name: string;
  lexicon?: string;        // optional — scopes the spell to a specific lexicon
  overview: string;
  context?: (string | ContextItem)[];
  tasks: Task[];
  depends?: string[];      // other spell names
  afterAll?: string[];     // CLI commands to run after all tasks complete
}
```

### Factory Functions

```typescript
function spell(def: SpellDefinition): SpellDefinition
function task(description: string, opts?: { done?: boolean }): Task
function file(path: string): ContextItem
function cmd(command: string): ContextItem
```

- `spell()` validates the name, freezes the object
- `task()` defaults `done` to `false`
- `file()` creates a `{ type: "file", value: path }` context item
- `cmd()` creates a `{ type: "cmd", value: command }` context item

### Name Validation

Names must be kebab-case: `[a-z0-9]+(-[a-z0-9]+)*`, max 64 characters. No underscores, no uppercase. Must not collide with CLI subcommand names (add, list, show, cast, done, rm, graph).

## Dependencies

Dependencies reference other spell names.

```typescript
export default spell({
  name: "deploy-k8s",
  lexicon: "k8s",
  overview: "Deploy workloads to Kubernetes",
  depends: ["deploy-aws-prod"],
  tasks: [
    task("Apply manifests"),
    task("Verify pod health"),
  ],
});
```

Acyclic — circular dependencies are an error.

### Dependency Validation

At discovery time, all `depends` references are checked against the name index. Dangling references are errors:

```
Error: Spell "deploy-k8s" depends on "deploy-aws-prod" which does not exist
```

Circular dependencies are detected via topological sort:

```
Error: Circular dependency detected: foo → bar → foo
```

### Status Derivation

Computed from file contents + dependency graph:

| Condition | Status |
|-----------|--------|
| Has incomplete dependencies | `blocked` |
| All deps done, has undone tasks | `ready` |
| All tasks done | `done` |

Three states. No state machine. The TypeScript file is the source of truth.

### Execution Model

Interactive and serial. One agent works on one spell at a time.

```bash
chant spell cast <name>     # Generate bootstrap prompt
```

The `cast` command generates a **bootstrap prompt** — it resolves context items, assembles the spell details into a structured prompt the agent can consume, and outputs to stdout. The prompt includes: overview, resolved context, lexicon skill guidance (if applicable), task list with done/undone status, dependency status, afterAll instructions, and general instructions (use `chant spell done` to mark tasks, commit with `Spell: <name>` trailer).

This is the same pattern chant-old used to avoid API throttling — the agent gets a pre-assembled context blob instead of spending turns reading files and running commands. The difference: no daemon, no process management, no non-interactive orchestration. The prompt is the entire interface.

Running `cast` on a blocked or done spell warns and exits. Use `--force` to proceed anyway.

### Task Completion

Agents mark tasks done via CLI, not raw text edits:

```bash
chant spell done <name> <task-number>   # Mark task N as done (1-based)
```

The `done` command rewrites the task in the TypeScript source — `task("description")` becomes `task("description", { done: true })`. The format is constrained enough for regex-based rewriting; no AST parser needed.

A core lint rule validates `*.spell.ts` files — parseable `task()` calls, valid kebab-case name, non-empty descriptions. `chant lint` catches hand-edited files before `chant spell done` hits a regex failure.

The agent then commits with the `Spell: <name>` trailer. If interrupted, completed tasks are already persisted in the file. Resume by running `cast` again — the agent sees remaining undone tasks and continues.

No `assigned` field. No PID tracking. No crash recovery mechanism. No daemon. You're at the controls.

## Discovery

Discovery starts at the **git root**:

- Spells: glob `<git-root>/spells/*.spell.ts`, dynamic import, index by `name`

### Error Handling

| Condition | Behavior |
|-----------|----------|
| Import fails (syntax error) | Report file + error message, skip |
| No default export | `"File X has no default export"` |
| Default export wrong shape | Runtime type check, report file |
| Duplicate name | `"Duplicate name 'foo' in X and Y"` |
| Dangling dependency | `"Spell 'foo' depends on 'bar' which does not exist"` |
| Circular dependency | `"Circular dependency: foo → bar → foo"` |
| `cast` on blocked/done | Warning + exit (use `--force` to proceed) |

## Git Integration

### Trailers

`Spell: <name>`. Multiple trailers per commit allowed.

```bash
# All spell names in history
git log --format='%(trailers:key=Spell,valueonly)' | grep -v '^$' | sort -u

# Commits for a specific spell
git log --all --format='%H %s' --grep='Spell: deploy-aws-prod'
```

### Spell Lifecycle

Spell files are ephemeral. Git history is the permanent record.

1. `chant spell add deploy-staging` — creates `spells/deploy-staging.spell.ts`
2. Agent works, marks tasks done, commits with `Spell: deploy-staging` trailer
3. All tasks done — status is `done`
4. `chant spell rm deploy-staging` — deletes the file, commits the deletion
5. Spell definition recoverable from git: `git show <commit>:spells/deploy-staging.spell.ts`

The last `Spell: deploy-staging` commit before deletion has the complete definition with all tasks marked done. `chant spell show deploy-staging` reconstructs from git history when the file is absent — finds the most recent commit with the `Spell: deploy-staging` trailer that included the file, and displays its contents.

Active spells live in `spells/`. Completed spells live in git. No archive folder.

## CLI

```
chant spell add <name>          Create spells/<name>.spell.ts
chant spell rm <name>           Delete spell (warns if dependents exist, --force to skip)
chant spell list                List spells with status, tasks, lexicon (--ready to filter)
chant spell show <name>         Show overview, context, tasks, related commits (--commits for git log)
chant spell cast <name>         Generate bootstrap prompt for agent
chant spell done <name> <N>     Mark task N as done (1-based)

chant graph                     Show dependency graph
```

### spell list

```
NAME              STATUS   TASKS   LEXICON   OVERVIEW
deploy-aws-prod   ready    [0/3]   aws       Deploy infra to production
deploy-k8s        blocked  [0/2]   k8s       Deploy workloads to Kubernetes
run-migrations    done     [2/2]   flyway    Apply database migrations
```

### graph

Simple text format — name → dependencies.

```
build-vpc → deploy-aws
deploy-aws → deploy-k8s
```

### Add Scaffold

`chant spell add <name>` generates:

```typescript
import { spell, task } from "@intentius/core";

export default spell({
  name: "<name>",
  overview: "",
  tasks: [
    task(""),
  ],
});
```

## MCP

Spells are exposed via MCP for native agent consumption. These are core MCP contributions — the MCP server registers them directly alongside plugin contributions. The server already iterates plugins for `mcpTools()` / `mcpResources()`; it additionally registers spell and state tools/resources from core. No new package or plugin interface needed.

### Tools

| Tool | Description |
|------|-------------|
| `spell-done` | Mark a spell task as done. Input: `{ name, taskNumber }` |

### Resources

| URI | Description |
|-----|-------------|
| `spells` | List all spells with status, tasks, lexicon |
| `spell/{name}` | Show spell details |
| `spell/{name}/prompt` | Bootstrap prompt (same as `chant spell cast`) |

The bootstrap prompt is available both as CLI stdout (`chant spell cast <name>`) and as an MCP resource (`spell/{name}/prompt`). CLI for piping and manual use, MCP for native agent access.

## Environments

Environments are defined in `chant.config.ts`:

```typescript
export default {
  // ... existing config ...
  environments: ["staging", "prod"],
};
```

Environment names are free-form strings. The config provides a canonical list for validation — `afterAll` commands referencing unknown environments warn, `chant state snapshot` validates against the list.

Lexicon plugins can use environments for provider-specific mapping (K8s namespace resolution, AWS stack naming). The environment string is passed through to `describeResources` and deploy workflows.

## When to Use a Spell

- **Yes**: multi-step work you want to track with tasks and commit association. Deploys, migrations, feature work, refactoring.
- **No**: single-command operations (`chant build`, `chant lint`), quick fixes, exploratory work. Don't over-structure.

Rule of thumb: if it has more than one task and you want a commit trail, use a spell. If it's a single command or a quick edit, just do it.

## Not Included

- Acceptance criteria validation
- Approval workflow
- Git notes
- Parallel execution / worktrees
- State machine / assigned tracking
- PID / process tracking
- Daemon
- Spell auto-archival
- Spell recurrence / scheduling
