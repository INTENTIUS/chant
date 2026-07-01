---
name: drift-check
description: Check whether the live cluster has drifted from source and summarize the change set. Read-only — never applies.
---

# Drift check

Use this to report whether the environment matches source. This is read-only.

1. Compute the change set against live:

   ```bash
   chant lifecycle plan local
   ```

   Actions are `create` / `update` / `delete` / `adopt` / `noop`. `delete` is
   only ever a chant-owned resource that is live but no longer declared. An
   undeclared live resource with no marker is `adopt`, never a delete.

2. For the raw three-way diff (declared / live / last snapshot):

   ```bash
   chant lifecycle diff local --live
   ```

3. Summarize what changed and why. Do not act on it.

Remediation is a human decision. To pull live changes back into source, a human
runs `chant run reconcile`, which opens a PR. To push source to the cluster, a
human runs a deploy Op. You do neither.
