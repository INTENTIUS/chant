---
skill: chant-fountain-secrets
description: Handle fountain secrets, env vars, and ${VAR} substitution safely from chant
user-invocable: true
---

# Fountain Secrets and Substitution

## The model

Everything materialized into a fountain sandbox must be presumed exfiltrated once untrusted agent code runs. Order of preference:

1. **`${VAR}` substitution references** in agent config (MCP server env, system prompts). Resolved at spawn from the merged environment + vault sets. Never a value in source.
2. **Environment secrets** (`spec.secrets`) — encrypted at rest, write-only over the API (values are never returned once stored). `fountainApply` sends them inline with the rest of the resource in the bulk apply request, and the server upserts them through the encrypted envelope path; a changed value cannot be detected, only overwritten.
3. **`env_vars`** — plaintext config only. FTN012 errors on credential-shaped keys or values here.

Never put a literal credential anywhere in a declaration: FTN001 catches known shapes (AWS keys, GitHub/Slack tokens, `sk-`/`ftn_` keys, private key material) at the AST; FTN015 errors on secret-shaped MCP env keys that are not `${VAR}` references.

## Vault semantics

Vault values **win on key collision** with the environment, silently, at spawn. FTN014 warns when a declared vault shadows a declared environment key, so the override is visible in review. Which vaults may attach to an agent is scoped by `allowed_vault_ids` (nullable: `null` = any tenant vault, `[]` = none, list = allowlist) — set `[]` on agents whose environment must not be overridable.

## Build-time resolution check

FTN013 warns when an agent references `${VAR}` and its declared environment has no such key (env_vars or secret keys). A vault can legitimately supply it at conversation create — the warning is "confirm this is intentional," not "this is broken."

## Round-trips and their limits

`chant import --from` exports live resources but never secrets: values are write-only upstream, and secret keys are not on the typed request surface. Re-declare imported environments' secrets through your secret provider. Upstream discussion of a reference-based model that would fix this: BinaryBourbon/fountain#148.
