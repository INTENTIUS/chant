# Lexicon State

Visibility into deployed infrastructure. Chant is a synthesis compiler — `chant build` generates templates but has zero knowledge of what's actually deployed. The optional `chant state snapshot` command queries cloud APIs to capture the **API delta**: physical IDs, status, timestamps, and cloud-assigned output properties that only exist after deployment. User-defined properties are reconstructable from the build output at the linked commit.

Drift detection is agent work, not a built-in feature. Agents compare state snapshots against live APIs using existing lexicon skills and provider CLIs.

## What State Captures

Since chant's build output IS the full resource spec (already in git at the build commit), state stores only what the cloud adds:

- **Physical IDs**: ARNs, resource IDs, pod names — provider-assigned identifiers
- **Status**: `CREATE_COMPLETE`, `Running`, `Active` — provider-specific status strings
- **Timestamps**: when resources were last updated
- **Output attributes**: cloud-assigned properties not in the spec — endpoint URLs, assigned IPs, default security groups, generated passwords

User-defined properties (instance type, subnet CIDR, container image) are NOT stored. Those are in the build output.

## Non-Authoritative by Design

State snapshots are observational — they can be stale, partial, or incomplete. Unlike Terraform or Pulumi where state IS the source of truth, chant snapshots record what was observed at a point in time.

Agents use snapshots as context for orientation, but MUST verify against live APIs before acting. A snapshot says "last time we looked, this VPC existed with ID vpc-abc123" — not "this VPC exists right now."

Gaps are expected and handled:
- Resource not in snapshot → agent queries the API directly
- Snapshot is stale → agent discovers current state via provider CLI
- Ambiguity → agent escalates to human review

The cost: agents do more verification work than they would with authoritative state. The benefit: no state locking, no state corruption, no state-vs-reality drift bugs, no sensitive data in state files.

## How Agents Should Use State

The workflow for agents consuming state snapshots:

1. **Read previous snapshot** — use `chant state show` or the MCP resource for orientation. What resources exist? What are their physical IDs? What was their status last time?
2. **Diff declarations** — run `chant state diff` to compare current build against the snapshot's digest. This shows what changed in declarations since the last deploy — added, removed, changed, or unchanged resources.
3. **Verify against live APIs** — the snapshot may be stale. Use provider CLIs (`aws cloudformation describe-stacks`, `kubectl get`, etc.) to confirm current state. The diff makes this targeted: changed and added resources need full verification, unchanged resources get a lighter check.
4. **Act on verified state** — deploy, update, or remediate based on what the live API reports, not what the snapshot says. Use the digest's dependency graph for deploy ordering within a lexicon.
5. **Take a fresh snapshot** — after operations complete, run `chant state snapshot` (or declare it as `afterAll` in a deploy spell) to capture the new state.
6. **Escalate gaps** — if live state doesn't match expectations and the resolution is ambiguous, escalate to human review rather than guessing.

## Build Digest

The snapshot answers "what did the cloud report?" The digest answers "what did the source declare?" Together they give agents full context: declared intent + observed reality.

The digest is pure synthesis — computed from `BuildResult` entities and the dependency graph, no API calls. `chant state snapshot` computes and stores the digest alongside API metadata.

**`propsHash`** is a fingerprint of the resource declaration: deterministic JSON stringify → hash. A changed hash means a changed declaration. Agents don't need to parse templates to detect changes.

**`dependencies`** is the resource-level dependency graph from discovery. Agents use it for deploy/verify ordering within a lexicon.

**`outputs`** and **`deployOrder`** come from the existing `BuildManifest` — cross-lexicon data flow and ordering.

### Digest diff

`chant state diff` compares the current build's digest against the previous snapshot's digest:

- **added** — in current build but not in previous snapshot's digest (new resource, needs initial deploy)
- **removed** — in previous digest but not in current build (resource removed from source)
- **changed** — `propsHash` differs (declaration changed, needs deploy attention)
- **unchanged** — `propsHash` matches (just verify it's still there)

The digest is optional on `StateSnapshot` so old snapshots degrade gracefully. `chant state snapshot` always populates it going forward. If the previous snapshot has no digest, `chant state diff` treats all resources as added.

## Data Model

### State snapshot (per lexicon per environment)

```json
{
  "lexicon": "aws",
  "environment": "staging",
  "commit": "abc123",
  "timestamp": "2026-03-03T10:00:00Z",
  "resources": {
    "clusterRole": {
      "type": "AWS::IAM::Role",
      "physicalId": "arn:aws:iam::123:role/my-role",
      "status": "CREATE_COMPLETE",
      "lastUpdated": "2026-03-03T10:00:00Z",
      "attributes": {
        "Arn": "arn:aws:iam::123:role/my-role",
        "RoleId": "AROAEXAMPLE"
      }
    },
    "vpc": {
      "type": "AWS::EC2::VPC",
      "physicalId": "vpc-abc123",
      "status": "CREATE_COMPLETE",
      "attributes": {
        "DefaultSecurityGroup": "sg-abc123",
        "CidrBlockAssociations": ["vpc-cidr-assoc-abc123"]
      }
    }
  }
}
```

### Types

```typescript
interface ResourceMetadata {
  type: string;                          // entity type (AWS::S3::Bucket, K8s::Apps::Deployment)
  physicalId?: string;                   // provider-assigned ID (ARN, resource ID, pod name)
  status: string;                        // provider-specific status string
  lastUpdated?: string;                  // ISO timestamp
  attributes?: Record<string, unknown>;  // cloud-assigned output properties
}

interface StateSnapshot {
  lexicon: string;
  environment: string;
  commit: string;                        // main branch commit this corresponds to
  timestamp: string;                     // when the snapshot was taken
  resources: Record<string, ResourceMetadata>;  // keyed by logical name
  /** Build digest at snapshot time — what was declared when this snapshot was taken */
  digest?: BuildDigest;
}

interface ResourceDigest {
  type: string;       // entityType (AWS::S3::Bucket, K8s::Apps::Deployment)
  lexicon: string;    // which lexicon owns this resource
  propsHash: string;  // hash of deterministically-serialized declaration props
}

interface BuildDigest {
  resources: Record<string, ResourceDigest>;          // keyed by logical name
  dependencies: Record<string, string[]>;             // resource-level dependency graph
  outputs: Record<string, { source: string; entity: string; attribute: string }>;  // cross-lexicon bridges
  deployOrder: string[];                              // lexicon-level deploy order
}

interface DigestDiff {
  added: string[];       // in current build but not in previous snapshot's digest
  removed: string[];     // in previous digest but not in current build
  changed: string[];     // propsHash differs
  unchanged: string[];   // propsHash matches
}
```

## Plugin Interface

New optional method on `LexiconPlugin`:

```typescript
interface LexiconPlugin {
  // ... existing methods ...

  /** Query deployed resources and return API metadata. Opt-in. */
  describeResources?(options: {
    environment: string;
    buildOutput: string;           // serialized build output for this lexicon
    entityNames: string[];         // logical names from the build
  }): Promise<Record<string, ResourceMetadata>>;
}
```

The plugin receives the environment name and build output. It determines how to find deployed resources on its own.

### Implementing describeResources

Implementation is lexicon-specific. Two worked examples:

**AWS** — straightforward. Stack name is derived from environment + project config (same convention as deploy). Call `describe-stack-resources` to get physical IDs and status, `describe-stacks` for outputs. Map logical names from the build output to stack resource entries. Single API call per stack.

**K8s** — harder. Must resolve the right context and namespace for the environment. Entity names map to `kind/name` pairs from the build output. Use `kubectl get` with JSON output. CRDs require the API group in the resource path. Namespace resolution needs a convention — environment maps to namespace (e.g., `staging` → `staging` namespace) or a config field. Plugin should document its namespace mapping.

## Orphan Branch

State lives on `chant/state`, an orphan branch with no shared history with main. All operations use git plumbing — no checkout, no branch switching, no working tree changes.

### Branch structure

```
chant/state (orphan branch)
├── staging/
│   ├── aws.json
│   └── k8s.json
└── prod/
    ├── aws.json
    └── k8s.json
```

### Git plumbing pipeline

1. `echo $JSON | git hash-object -w --stdin` — write blob, get SHA
2. `git mktree` — build tree from blob entries for `{env}/{lexicon}.json`
3. `git commit-tree -m "State snapshot" [-p $PREV] $TREE` — create commit
4. `git update-ref refs/heads/chant/state $COMMIT` — advance branch ref
5. `git show chant/state:{env}/{lexicon}.json` — read state

All via `getRuntime().spawn()`. No checkout, no branch switching.

### Reading state

```bash
git show chant/state:staging/aws.json    # latest snapshot
git log chant/state                       # snapshot history
```

### Commit linkage

State snapshots reference the main branch commit they correspond to (the `commit` field in the JSON). Optionally, a `State: <sha>` trailer on main branch commits links deploy events to their state snapshots.

### Auto-push / Auto-fetch

`chant state snapshot` pushes the state branch to remote after committing (if remote exists).

`chant state show` and `chant state log` fetch the state branch from remote before reading (if remote exists). This ensures `git clone` + `chant state show` works without manual fetch configuration.

Both operations are transparent — no user intervention. First snapshot on a fresh clone auto-creates the orphan branch.

## CLI

```
chant state snapshot <environment> [lexicon]   Query API, save metadata to orphan branch
chant state show <environment> [lexicon]       Show latest state snapshot
chant state diff <environment> [lexicon]       Compare current build against last snapshot's digest
chant state log [environment]                  History of state snapshots
```

### Example workflow

```bash
# After deploying to staging
chant state snapshot staging
# -> Querying aws... 12 resources
# -> Querying k8s... 8 resources
# -> Snapshot saved to chant/state (commit abc123)

# View current state
chant state show staging aws
# RESOURCE         TYPE                    PHYSICAL ID                           STATUS
# clusterRole      AWS::IAM::Role          arn:aws:iam::123:role/my-role         CREATE_COMPLETE
# vpc              AWS::EC2::VPC           vpc-abc123                            CREATE_COMPLETE
# ...

# See what changed since last snapshot
chant state diff staging aws
# RESOURCE          STATUS     TYPE
# clusterRole       changed    AWS::IAM::Role
# nodeGroup         added      AWS::EKS::Nodegroup
# oldBucket         removed    AWS::S3::Bucket
# vpc               unchanged  AWS::EC2::VPC

# State history
chant state log staging
# abc123  2026-03-03  staging  aws(12) k8s(8)
# def456  2026-02-28  staging  aws(10) k8s(8)
```

## Connection to Spells

Deploy spells declare state snapshots via `afterAll`:

```typescript
export default spell({
  name: "deploy-staging",
  lexicon: "aws",
  overview: "Deploy infrastructure to staging",
  tasks: [
    task("Build and validate templates"),
    task("Apply changeset to staging"),
  ],
  afterAll: ["chant state snapshot staging"],
});
```

The bootstrap prompt includes `afterAll` commands as post-completion instructions. Still agent-driven execution, but the connection is declarative instead of buried in task text.

## Snapshot Orchestration

`takeSnapshot(environment, plugins, buildResult)` orchestrates:

1. For each plugin with `describeResources`, call it with the environment, serialized build output, and entity names
2. Assemble `StateSnapshot` per lexicon
3. Write all snapshots to orphan branch in a single commit
4. Handle partial failures — one lexicon fails, others still succeed
5. Push to remote if it exists

Multi-environment is supported from day one. Environments are defined in `chant.config.ts` (see Agent Spells spec). `chant state snapshot` validates the environment argument against the config list.

## Snapshot Validation

`describeResources` returns are validated against the `ResourceMetadata` shape before writing:

- Each resource must have at least `type` and `status`. Resources missing these fields are dropped with a warning.
- Partial snapshots are committed — if 10 of 12 resources succeed, the 10 are written. The warning output shows which resources were dropped and why.
- Empty snapshots (zero valid resources) are not committed. The command exits with an error.
- `chant state show` includes a resource count and timestamp so staleness is visible: `staging/aws — 12 resources — 2026-03-03T10:00:00Z`.

No rollback command. Git history is the rollback: `git show chant/state~1:staging/aws.json` retrieves the previous snapshot.

## Sensitive Data

`describeResources` implementations MUST scrub sensitive data before returning results. This is a blocking contract, not a recommendation.

**What must be scrubbed:**
- Passwords and connection strings
- API keys, tokens, and secrets
- TLS certificates and private keys
- Any value that would be dangerous if committed to git

**How to scrub:**
- Replace sensitive values with `"[REDACTED]"` or omit the field entirely
- The core validates common sensitive patterns (strings matching `password`, `secret`, `token`, `key` in attribute names) and warns if potential sensitive data is detected
- Plugin code review MUST verify scrubbing — this is a blocking requirement, not a best-effort guideline

**The advantage:** because scrubbing is mandatory and enforced, state snapshots never contain sensitive data. This means git storage is safe, snapshots can be shared freely, and there's no need for encrypted state backends.

## Git Storage Trade-offs

State lives in git (on the `chant/state` orphan branch). This is a deliberate choice with real trade-offs.

**Git gives you:**
- Versioning — every snapshot is a commit, `git log` shows history, `git diff` shows changes
- Diffs — compare snapshots across deploys or environments
- Portability — clone the repo and you have the full state history
- Offline access — no network needed to read state
- No external dependencies — no S3 bucket, no DynamoDB table, no Consul cluster

**Git lacks:**
- **Locking** — last push wins. Acceptable because state is non-authoritative; a stale snapshot is inconvenient, not dangerous. Agents verify against live APIs regardless.
- **Encryption at rest** — git objects are plaintext. Acceptable because sensitive data is scrubbed before storage.
- **Access control separation** — state access = repo access. If you need separate permissions for state vs. source, git doesn't help.
- **Size management** — snapshots accumulate. For most projects this is negligible; for very large deployments, periodic `git gc` or branch reset may be needed.

No S3/GCS backend is planned. The trade-offs above are acceptable for non-authoritative, scrubbed state data.

## MCP

State is exposed as MCP resources for agent consumption:

| URI | Description |
|-----|-------------|
| `state/{environment}` | All lexicon snapshots for an environment |
| `state/{environment}/{lexicon}` | Single lexicon snapshot (structured JSON) |

`state-snapshot` and `state-diff` are exposed as MCP tools:

```typescript
{
  name: "state-snapshot",
  description: "Capture deployed state for an environment",
  inputSchema: {
    type: "object",
    properties: {
      environment: { type: "string" },
      lexicon: { type: "string", description: "Optional — snapshot all lexicons if omitted" }
    },
    required: ["environment"]
  }
}
```

```typescript
{
  name: "state-diff",
  description: "Compare current build declarations against last snapshot's digest",
  inputSchema: {
    type: "object",
    properties: {
      environment: { type: "string" },
      lexicon: { type: "string", description: "Optional — diff all lexicons if omitted" }
    },
    required: ["environment"]
  }
}
```

These are core MCP contributions — the MCP server registers them directly alongside plugin contributions. No new package or plugin interface needed.

## Implementation

### New files

```
packages/core/src/state/types.ts       ResourceMetadata, StateSnapshot, BuildDigest, DigestDiff interfaces
packages/core/src/state/git.ts         Orphan branch operations (plumbing)
packages/core/src/state/snapshot.ts    Snapshot orchestration
packages/core/src/state/digest.ts      computeBuildDigest(), diffDigests(), hashProps()
packages/core/src/cli/handlers/state.ts  CLI handlers
```

### Modified files

```
packages/core/src/lexicon.ts           Add describeResources?() to LexiconPlugin
packages/core/src/build.ts             Add `dependencies` field to BuildResult (already computed, currently discarded after topo sort)
packages/core/src/cli/main.ts          Add state commands to registry
packages/core/src/index.ts             Export state module
```

### Reuse

- `getRuntime().spawn()` for git plumbing commands
- `getRuntime().hash()` from `packages/core/src/lexicon-integrity.ts` for `propsHash`
- `sortedJsonReplacer` from the diff command pattern for deterministic serialization
- `build()` for entity names + build output
- `CommandDef` / `CommandContext` for CLI registration
- `formatSuccess()` / `formatError()` for terminal output
- `isLexiconPlugin()` type guard

### Tests

- `state-git.test.ts` — orphan branch creation, snapshot write/read via git plumbing (temp git repos)
- `state-snapshot.test.ts` — snapshot orchestration with mock plugins

## Not Included

- Drift detection (agent work — compare `chant state show` against live APIs via existing lexicon skills)
- Full API response caching
- Auto-snapshot after deploy
- Resource import (agentic skill — agents use state snapshots + lexicon skills to import existing resources)
- State locking for concurrent operations
