# Dogfood Results: Spells + State on GCP Examples

**Date:** 2026-03-05
**Cluster:** gke-microservice (us-central1, project: lucid-volt-257820)

## Spells Completed

| Spell | Resources | Status |
|-------|-----------|--------|
| gke-bootstrap | GKE cluster + Config Connector | done [3/3] |
| gcp-basic-bucket | 1 (StorageBucket) | done [4/4] |
| gcp-cloud-function | 4 (CloudFunction, PubSubTopic, PubSubSubscription, StorageBucket) | done [4/4] |
| gcp-cloud-sql | 4 (SQLInstance, SQLDatabase, SQLUser, ComputeAddress) | done [4/4] |
| gcp-gke-cluster | 2 (ContainerCluster, ContainerNodePool) | done [4/4] |
| gcp-vpc-network | 8 (VPC, 3 Subnets, 2 Firewalls, Router, RouterNAT) | done [4/4] |

**Total:** 19 GCP resources deployed via Config Connector

---

## Bugs Found and Fixed

### 1. `spell add` template wrong import (spell.ts:47)
- **Severity:** P1 — all generated spell files would have broken imports
- **Was:** `import { spell, task } from "@intentius/core";`
- **Fixed to:** `import { spell, task } from "@intentius/chant";`

### 2. Compound command arg routing (systemic)
- **Severity:** P0 — all compound commands (`spell show`, `spell cast`, `spell done`, `state diff`, `state snapshot`, etc.) were broken
- **Root cause:** Handlers read `args.path` for their first argument, but for compound commands `path` contains the subcommand name. The actual argument was in `args.extraPositional`.
- **Files fixed:** `spell.ts`, `state.ts`, `main.ts`
- **Detail:** `runSpellDone` also needed `args.extraPositional2` for the task number

### 3. Composite function discovery (not directly fixed — worked around)
- **Severity:** P1 — all GCP examples using composite functions (`GcsBucket()`, `GkeCluster()`) produced empty config.yaml (only annotations)
- **Root cause:** Composite functions return `Record<string, unknown>` without `DECLARABLE_MARKER`, so the build system can't discover them
- **Workaround:** Rewrote all 5 examples to use direct resource constructors (`new StorageBucket({...})`)
- **TODO:** Fix composite functions to return Declarable-marked objects, or change discovery to handle them

---

## CRD Validation Errors (deploy-time)

### 4. CloudFunction — `spec.eventTrigger.pubsubTopic` invalid
- **Example:** cloud-function
- **Error:** Config Connector rejected `pubsubTopic` on eventTrigger
- **Fix:** Changed to `resourceRef: { name: "events-topic", kind: "PubSubTopic" }`

### 5. CloudFunction — `spec.region` required
- **Example:** cloud-function
- **Error:** Missing required field
- **Fix:** Added `region: "us-central1"`

### 6. CloudFunction — `spec.availableMemoryMb` must be integer
- **Example:** cloud-function
- **Error:** String value "512M" rejected
- **Fix:** Changed to integer `512`

### 7. ComputeAddress — `spec.location` required
- **Example:** cloud-sql
- **Error:** `couldn't find spec.location field in ComputeAddress`
- **Fix:** Added `location: "us-central1"`

### 8. ContainerCluster — `spec.removeDefaultNodePool` unknown field
- **Example:** gke-cluster
- **Error:** `strict decoding error: unknown field "spec.removeDefaultNodePool"`
- **Fix:** Removed field (Terraform concept, not Config Connector)

### 9. ComputeFirewall — `spec.allowed` unknown field
- **Example:** vpc-network
- **Error:** `strict decoding error: unknown field "spec.allowed"`
- **Fix:** Changed to `allow` (correct CRD field name)

---

## Build Warnings (all examples)

### Per-resource warnings

| Warning | Count | Examples Affected |
|---------|-------|-------------------|
| No deletion-policy annotation — defaults to "delete" | 18 | all 5 |
| Missing encryption or backup configuration | 1 | cloud-sql |
| Overly broad cloud-platform OAuth scope | 1 | gke-cluster |
| References resource not in output (external refs) | 2 | cloud-sql |

### Global warnings (every example)

| Warning | Description |
|---------|-------------|
| No IAMAuditConfig resource found | Consider adding audit logging |
| No Service (serviceusage) resource found | Consider enabling required GCP APIs |
| No VPC Service Controls perimeter found | Consider adding for data exfiltration protection |

**Total build warnings across all examples: ~40**

---

## State System Findings

### `state diff` — works correctly
- All 5 examples show all resources as "added" (no previous snapshot)
- Correctly identifies resource types and names
- Output is clean and readable

### `state snapshot` — fails gracefully
- Error: `gcp: no valid resources returned`
- Root cause: GCP plugin's `describeResources` not implemented / no kubectl-based resource status query
- **TODO:** Implement `describeResources` for GCP lexicon

---

## Spell System Findings

### What works well
- `spell list` — clean table with status, task counts, lexicon, overview
- `spell cast` — generates well-formatted prompt with resolved file context
- `spell done` — correctly rewrites source files to mark tasks done
- Spell discovery from `spells/` directory works reliably

### Issues
- `bunx chant` doesn't resolve — had to use `bun run packages/core/src/cli/main.ts --` for all CLI calls
- `state diff` run from project root rebuilds ALL lexicons (slow) — should scope to current example
- `state snapshot` error message is terse — could suggest next steps

---

## Recommendations

1. **Fix composite function discovery** — this is the biggest usability gap. Users writing `export const { bucket } = GcsBucket({...})` get silently empty configs.
2. **Add `chant` bin link** to package.json so `bunx chant` works from examples
3. **Implement GCP `describeResources`** so state snapshots work
4. **Validate CRD field names at build time** — many deploy errors (allowed→allow, removeDefaultNodePool, pubsubTopic→resourceRef) could be caught during build
5. **Add deletion-policy annotation helper** — every resource triggers this warning; add a default or convenience function
6. **Scope `state diff` to current project** when run from an example directory
