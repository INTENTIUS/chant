---
skill: chant-temporal-ops
description: Signal workflows, diagnose stuck activities, reset checkpoints, and cancel runs via the Temporal CLI and chant run
user-invocable: true
---

# Temporal Operations Playbook

## Signal a gate (unblock a paused workflow)

Workflows that use `setHandler` on a signal pause at gate activities waiting for a named signal. The `chant run signal` command (available in issue #8) forwards signals to the running workflow.

```bash
# Via chant CLI (requires chant run — issue #8)
chant run signal <op-name> dnsConfigured

# Directly via temporal CLI
temporal workflow signal \
  --workflow-id <workflow-id> \
  --name dnsConfigured \
  --namespace <namespace>
```

List pending signals by querying the workflow:

```bash
temporal workflow query \
  --workflow-id <workflow-id> \
  --type currentPhase \
  --namespace <namespace>
```

## Check run status

```bash
# Summary view
temporal workflow describe --workflow-id <id> --namespace <ns>

# Full event history
temporal workflow show --workflow-id <id> --namespace <ns>

# Filter by search attribute (requires registered custom attributes)
temporal workflow list \
  --namespace <ns> \
  --query 'GcpProject = "my-project"'
```

## Diagnose a stuck activity

Activities can be stuck for three distinct reasons:

| Symptom | Cause | Fix |
|---|---|---|
| Activity never started | `scheduleToStartTimeout` exceeded — no available workers | Start the worker: `chant run <op>` |
| Activity started but no heartbeats | `heartbeatTimeout` exceeded — worker crashed mid-activity | Bounce the worker; Temporal auto-retries |
| Activity running but slow | Normal — long-running activities with heartbeats | Wait, or check heartbeat details |

### View activity timeout details

```bash
temporal workflow show --workflow-id <id> --namespace <ns> | grep -A5 "ActivityTaskScheduled"
```

### Check worker connectivity

```bash
# See which task queues have pollers
temporal task-queue describe --task-queue <queue> --namespace <ns>
```

A task queue with `pollerCount: 0` means no workers are running.

## Reset a workflow to a previous checkpoint

Use `workflow reset` to replay a workflow from a specific event, skipping failed activities:

```bash
# Reset to just before the most recent failure
temporal workflow reset \
  --workflow-id <id> \
  --namespace <ns> \
  --event-id <N> \
  --reason "Retrying after infra fix"
```

Find the event ID to reset to:

```bash
# List events — find the last successful ActivityTaskCompleted before the failure
temporal workflow show --workflow-id <id> --namespace <ns> | grep -n "ActivityTask"
```

Reset to the beginning of a named phase (requires workflow to record phase transitions as signals or markers):

```bash
temporal workflow reset \
  --workflow-id <id> \
  --namespace <ns> \
  --reapply-type None \
  --type LastWorkflowTask
```

## Cancel a stuck or unwanted run

```bash
# Graceful cancel — workflow receives CancellationError and can clean up
temporal workflow cancel \
  --workflow-id <id> \
  --namespace <ns>

# Forceful terminate — immediate stop, no cleanup
temporal workflow terminate \
  --workflow-id <id> \
  --namespace <ns> \
  --reason "Terminated by operator"
```

## Pause and resume a schedule

```bash
# Pause
temporal schedule pause \
  --schedule-id <id> \
  --namespace <ns> \
  --note "Paused for maintenance"

# Resume
temporal schedule unpause \
  --schedule-id <id> \
  --namespace <ns>

# Trigger immediately (ignores spec)
temporal schedule trigger \
  --schedule-id <id> \
  --namespace <ns>
```

## Inspect workflow history for debugging

```bash
# Show all events in JSON (machine-readable)
temporal workflow show \
  --workflow-id <id> \
  --namespace <ns> \
  --output json

# Filter to activity failures only
temporal workflow show \
  --workflow-id <id> \
  --namespace <ns> \
  --output json | jq '.[] | select(.eventType == "ActivityTaskFailed")'
```

## Common failure patterns

### "no workers polling" after `chant run`

The worker started but cannot connect. Check:
1. `TEMPORAL_ADDRESS` matches the server address
2. `TEMPORAL_NAMESPACE` matches the namespace the workflow was started in
3. TLS and API key config match (`tls: true` + `apiKey` for Temporal Cloud)

### Activity retrying indefinitely

Default retry policy has `maximumAttempts: 0` (unlimited). If an activity is retrying unexpectedly:

```bash
# Check the current attempt count and last failure
temporal workflow show --workflow-id <id> --namespace <ns> | grep "attempt\|failure"
```

Add `maximumAttempts` to the activity's retry policy in the workflow code, or cancel the run.

### "workflow execution already started" on re-run

`chant run` uses deterministic workflow IDs (e.g. `crdb-deploy-{project}`). If a previous run is still open:

```bash
# Check if it's still running
temporal workflow describe --workflow-id <id> --namespace <ns> | grep "status"

# If stuck, terminate it first
temporal workflow terminate --workflow-id <id> --namespace <ns> --reason "Restarting"
```
