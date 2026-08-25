# committed-encrypted — a SOPS provenance primitive for `declareSecret()`

Design deliverable. No code ships from this doc; it answers the design questions against the
current tree and proposes a sequenced set of follow-up issues.

Tracked externally: `lex00/iac-cd-bench#31`, epic `lex00/iac-cd-bench#6`. There is no chant issue
number yet, hence the descriptive filename rather than the `365-` prefix the neighbouring doc uses.

Reference estate: knr-ops, a Flux GitOps repo that encrypts only the `data`/`stringData` fields of
`*.sops.yaml` files against one age recipient via a repo-root `.sops.yaml`, lists those files as
plain kustomize resources, and sets `spec.decryption.provider: sops` plus `secretRef: sops-age` on
the consuming Flux `Kustomization`. The age key is bootstrap-injected and never in git.

## Summary of conclusions

1. The declaration is a path, not bytes. `declareSecret({ provenance: "committed-encrypted", file })`
   records a repo-relative path and nothing else; the factory stays pure and touches no filesystem,
   which is what keeps it foldable under `--sandbox`. See §2.
2. The ciphertext reaches the output as a sidecar file, never as a document in the primary output.
   That is the load-bearing decision: chant's own appliers read the primary output, so keeping the
   ciphertext out of it makes "chant pushes an undecrypted Secret into a cluster" structurally
   impossible rather than merely unlikely. See §3 and §6.
3. The file read happens at `buildRoots()`, the one sanctioned impure seam, following cedar's
   `Schema` precedent exactly. This needs one small core change: `BuildRootContext` must carry the
   discovered entities so the contributor can see the declarations. See §3.
4. Flux needs no codegen work. `Kustomization_Decryption` already exists on the generated typed
   class; only `FluxAppFor` needs a pass-through. See §4.
5. WK8005, WK8041 and WK8042 need no change at all — they cannot see a SOPS Secret. This
   contradicts the framing in the issue; the detail is in §5.
6. `chant lifecycle diff --live` already handles this case correctly and for free, via the k8s
   masking hook. See §6.

## 1. What exists today

The three shipped primitives all live in one file,
`packages/core/src/secret-provenance.ts`:

- `SecretProvenance` (line 42) is a closed union of `"referenced" | "from-provider" | "generated-once"`,
  with `SECRET_PROVENANCE_KINDS` (line 45) as the exhaustiveness list and the runtime membership
  check in `declareSecret` (line 186).
- `NoSecretMaterial` (line 84) types `value`, `data`, `stringData`, `material`, `plaintext` and
  `ciphertext` as `never` on every factory input; `FORBIDDEN_MATERIAL_FIELDS` (line 93) is the same
  list checked at runtime, and the thrown message names the offending key only, never its value
  (lines 192–200).
- Each kind copies its own fields explicitly in a `switch` (lines 215–249) — `input` is never
  spread, so a field that slipped past the type system still cannot land on the declaration.
- `lockDeclaredFields` (line 258) makes declared fields non-writable without sealing, because
  discovery stamps symbol-keyed metadata onto entities afterwards.
- `collectSecretDeclarations` (line 280) is the read surface every consumer uses.

Declarations are serializer-neutral: `partitionByLexicon` (`packages/core/src/build.ts`, line 305)
skips them, so no serializer ever sees one. `chant list` shows them; lint reads them.

WK8503 (`lexicons/k8s/src/lint/post-synth/wk8503.ts`) is the consumer that matters here. It builds
two sets: `collectProducedSecrets` (line 56) walks the manifests for `Secret`, `ExternalSecret`,
`InfisicalSecret`, `InfisicalDynamicSecret` and cert-manager `Certificate`, recording
`{name, namespace}`; and `declaredNames` (line 165) collects every `SecretDeclaration` name as a
typed waiver. A reference passes if either set covers it — but the producer path does namespace
matching (`producerCovers`, line 149) and the waiver path does not.

The taxonomy row this doc fills in is documented in
`docs/src/content/docs/concepts/where-values-come-from.mdx` line 61, and the code comment marking it
absent is at `packages/core/src/secret-provenance.ts` lines 29–30. Grepping the tree for "sops"
returns exactly those two hits — there is no partial implementation to build on.

## 2. The `declareSecret` API

```typescript
export interface CommittedEncryptedSecretInput extends NoSecretMaterial {
  readonly name: string;
  readonly provenance: "committed-encrypted";
  /** Repo-relative path to the committed ciphertext file. */
  readonly file: string;
  /** Encryption tool. Closed union; "sops" is its only member today. */
  readonly encryption?: "sops";
  /** Public recipient identifiers — age recipients or PGP fingerprints. */
  readonly recipients?: readonly string[];
  /** The declared key-set of the decrypted Secret, same contract meaning as generated-once. */
  readonly keys?: readonly string[];
}
```

with the matching `CommittedEncryptedSecretDeclaration`, a fourth `declareSecret` overload, and
`"committed-encrypted"` appended to `SECRET_PROVENANCE_KINDS`.

Authored, it reads:

```typescript
export const dbCredentials = declareSecret({
  name: "db-credentials",
  provenance: "committed-encrypted",
  file: "secrets/db-credentials.sops.yaml",
  encryption: "sops",
  keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
});
```

Field-by-field reasoning:

`file`, not `ciphertext`. The name is forced by the existing code: `ciphertext` is already in
`FORBIDDEN_MATERIAL_FIELDS` (`secret-provenance.ts` line 99) and any input carrying it throws. That
is the right outcome — the declaration points at bytes, it does not carry them — and it means the
constitutional guard needs no weakening to accommodate the new kind. `path` was the alternative;
`file` avoids confusion with Flux's `spec.path`, which is a directory.

`encryption` is a closed union with one member rather than a free string, so a second tool later is
a deliberate widening with a lint story attached, not an unvalidated string that silently means
nothing. Defaulting it to `"sops"` when omitted keeps the common case terse.

`recipients` is worth carrying. Age recipients and PGP fingerprints are public by definition — they
are the opposite of material — and recording them makes two future checks possible: that the file's
own `sops` block lists the recipients the author believes it does, and that a repo-root `.sops.yaml`
creation rule covers the declared path. Both are deferred (see §7). One guard should ship with the
field regardless: reject any entry matching `AGE-SECRET-KEY-` or a PEM private-key header, naming
the field and not the value. A private key pasted where a recipient belongs is a cheap, high-value
footgun to catch.

`keys` mirrors `GeneratedOnceSecretDeclaration.keys` (line 134) and carries the same meaning:
presence and key names, never values. It is what a WK8503 refinement and a future contract check
compare against, and §5's WK8504 can verify it against the ciphertext file's own key set — the key
names of a SOPS-encrypted Secret are cleartext, only the values are `ENC[...]`.

Validation inside `declareSecret`, all of it pure and offline:

- `file` must be a non-empty string, must not be absolute, and must not contain a `..` segment.
  The factory does not stat it. Discovery folds project source statically under `--sandbox`
  (`examples/sandbox-execution-boundary.test.ts`), and a factory that touched the filesystem would
  either break folding or reintroduce the trust boundary that suite exists to defend.
- `encryption`, when present, must be `"sops"` — the same shape as the existing provenance-kind
  check at line 186.
- `recipients` and `keys` are copied through `Object.freeze([...])`, as `generated-once` does with
  `keys` at line 245.
- The explicit-copy `switch` gains a fourth case; `input` is still never spread.

Nothing about the k8s Secret's namespace appears here. Core is lexicon-neutral, and the ciphertext
file already carries `metadata.namespace` in cleartext (SOPS encrypts values, not structure), so the
k8s side reads it from there rather than asking the author to restate it and risk disagreement.

### What WK8503 accepts as satisfied

The zero-change answer is that it already works: `declaredNames` (wk8503.ts line 165) collects every
declaration name regardless of kind, so a committed-encrypted declaration waives the check the moment
it exists. That is also the wrong answer, because it makes the strongest of the four kinds behave
like the weakest. `referenced` is a promise about something outside the build. committed-encrypted is
a claim about an artifact *inside* the build, and a claim inside the build should be verified, not
waived.

Recommendation: committed-encrypted declarations join the **producer** set, not the waiver set.
`collectProducedSecrets` gains a pass over `collectSecretDeclarations(ctx.entities)` that pushes
`{ name, namespace }` for each committed-encrypted declaration, with the namespace read from the
resolved ciphertext document (§3 puts that document in the build). Consequences:

- Namespace matching applies, via the existing `producerCovers` (line 149). A Secret encrypted into
  `namespace: platform` no longer silently satisfies a workload in `apps`.
- The claim is falsifiable. WK8504 (§5) fails the build when the named file does not resolve to a
  Secret of that name, so "declared" and "produced" cannot drift apart.
- The waiver path keeps its current meaning — a human's word — for the three kinds where that is
  all there is.

The `declaredNames` waiver should therefore skip `committed-encrypted`, so that a declaration whose
file is broken cannot both fail WK8504 and silently satisfy WK8503.

## 3. Build-time behaviour

The requirement is narrow and absolute: `chant build` must produce byte-identical output on every
run, must work with no network and no age key present, and must never place plaintext anywhere. That
rules out invoking `sops` at all — build-time decryption would need the key, which by construction
is not in the repo.

Three stages.

**Stage 1 — declaration (pure).** `declareSecret` records the path. No filesystem access. Foldable.

**Stage 2 — resolution, at `buildRoots()`.** This is chant's declared impure seam
(`packages/core/src/lexicon.ts`, `BuildRootContext` / `BuildRootContribution`), and it already has
two users doing exactly this shape of work: the k8s lexicon shells out to `kustomize build`
(`lexicons/k8s/src/plugin.ts` → `lexicons/k8s/src/kustomize/root.ts`), and the cedar lexicon
`readFileSync`s a schema off disk and wraps it in an entity
(`lexicons/cedar/src/schema-artifact.ts`, `schemaBuildRoot`). The cedar shape is the closer
precedent and the one to copy: read the bytes, wrap them in a declarable carrying `{ filename, text }`,
let the serializer write them out verbatim.

Reading a committed file at build time is inside the determinism boundary, and it is worth being
precise about why. `docs/src/content/docs/concepts/where-values-come-from.mdx` refuses *runtime
lookups* — reaching out to a live system, whose answer can change without the source changing. A
file versioned in the same commit as the TypeScript that names it is the same category as the
TypeScript itself: same repo state in, same output out. `kustomize/root.ts`'s module doc already
states this guarantee for a strictly more impure case (it spawns a subprocess), and the SOPS path is
tamer — no subprocess, no binary dependency, no fallback chain.

Three build-time guarantees, matching that doc's own framing:

- Deterministic. The bytes are copied, not re-serialized. No parse-and-re-emit round trip, no key
  sorting, no timestamp, no digest that changes on re-encryption.
- Offline. No `sops` binary, no key, no network. A missing binary is not a failure mode because no
  binary is invoked.
- Fails loudly, not weirdly. A missing file, an unreadable file, a non-Secret document, or a
  name mismatch refuses with the declared path in the message before anything is emitted.

One core change is required. `BuildRootContext` today carries only `{ projectRoot, config }`, so a
contributor cannot see the declarations it needs to act on. Recommendation: extend it with a
read-only `entities: ReadonlyMap<string, Declarable>`. The ordering is already correct —
`mergeBuildRootEntities` runs at build step 4b, after discovery — so this is a widening of the
context object, not a reordering. It also generalises: any future contributor that reacts to what
the project declared needs the same thing.

The two alternatives were considered and rejected. Listing the paths in `chant.config.ts` (the
`k8s.kustomize.roots` shape) works with no core change, but splits one fact across two files and
lets the config and the declaration disagree. Reading the file inside the k8s serializer would need
a new `SerializeContext.secrets` channel (the `receipts` precedent, `packages/core/src/serializer.ts`
line 34) *and* would establish serializers doing filesystem I/O, which is a worse precedent than the
seam that already exists for it.

Validation at this stage, before any entity is contributed:

- The file exists and is readable.
- It parses as YAML and is a single document (see §7 for multi-document files).
- `apiVersion: v1`, `kind: Secret`.
- `metadata.name` equals the declaration's `name`.
- A top-level `sops` block is present.
- Every value under `data`/`stringData` is `ENC[...]`-shaped. This is the check that earns the
  feature: it catches "edited the file and forgot to re-encrypt" at build time, which is the exact
  failure mode that puts plaintext into git. It reads a value to test a prefix, inside one frame,
  and reports the offending KEY name only — the pattern `declareSecret`'s own runtime guard uses at
  `secret-provenance.ts` lines 192–200. Scope it to `data`/`stringData` alone: SOPS's
  `encrypted_regex` leaves `apiVersion`, `kind` and `metadata` cleartext by design, which is what
  knr-ops does.

**Stage 3 — emission.** The contributed entity is an `EncryptedSecretFile` declarable in the k8s
lexicon, marked with a `Symbol.for` marker in the manner of `RENDERED_MANIFEST_MARKER`
(`lexicons/k8s/src/kustomize/rendered-entity.ts` line 27). The k8s serializer recognises the marker
and routes it to `SerializerResult.files`, excluding it from the primary multi-document YAML.

`lexicons/k8s/src/serializer.ts` returns a bare `string` today, so this widens its return type to
`SerializerResult` (`packages/core/src/serializer.ts` line 40). The primary content is unchanged;
`files` is populated only when a committed-encrypted declaration is present, so nothing about the
existing output moves.

Two rough edges in the CLI writer to handle:

- `packages/core/src/cli/commands/build.ts` lines 653–668 tries `JSON.parse` on every additional
  file and, on success, rewrites it key-sorted and possibly through `jsonToYaml`. A `.sops.yaml`
  file fails that parse and is written as-is, which is correct — but correct by accident. A
  `.sops.json` file would be silently rewritten. Recommendation for v1: restrict `file` to `.yaml`
  and `.yml`, refusing anything else with a message naming the extension, and file a follow-up to
  add a `SerializerResult.verbatimFiles` channel written with no round trip at all.
- With no `--output`, additional files are echoed to stderr rather than written (line 681).
  Recommendation: a build carrying a committed-encrypted declaration and no `--output` refuses,
  naming the flag. Printing ciphertext to a terminal is not useful and quietly dropping the file is
  worse.

Also worth noting for the implementing issue: `additionalFiles` is a single flat map across all
lexicons with last-writer-wins on collision, and there is no path-traversal guard on the keys. The
`..`-rejection in `declareSecret` covers the SOPS path, but the general gap should be filed.

Output layout, using `examples/flux-apps` as the reference project shape:

```
dist/apps/api/manifests.yaml          # primary — every declared manifest, no ciphertext
dist/apps/api/db-credentials.sops.yaml # sidecar — byte-identical copy of the committed file
```

The sidecar filename is `basename(file)` by default, matching cedar's `basename(source.path)`.

## 4. The Flux emission path

Flux is the component that actually decrypts, via `spec.decryption` on the `Kustomization`:

```yaml
spec:
  decryption:
    provider: sops
    secretRef:
      name: sops-age
```

The typed class already supports this. `lexicons/k8s/surface.snapshot.json` carries
`Kustomization_Decryption` as `K8s::Flux::Kustomization.decryption` — the CRD codegen picked it up
from the pinned flux2 v2.9.1 schemas. No codegen change, no CRD re-pin.

What is missing is the composite pass-through. `FluxAppFor`
(`lexicons/k8s/src/composites/flux-app.ts`, `FluxAppForOptions` at line 129) exposes `interval`,
`prune`, `wait`, `targetNamespace`, `timeout`, `suspend`, `serviceAccountName` and `dependsOn`, but
not `decryption`. Add:

```typescript
/** SOPS decryption for the reconciled path. A string is shorthand for the age Secret's name. */
decryption?: "sops" | { provider: "sops"; secretRef?: string };
```

rendering into the composite's `spec` alongside the existing conditional spreads (lines 232–243):

```typescript
...(decryption !== undefined && {
  decryption: {
    provider: "sops",
    ...(secretRefName !== undefined && { secretRef: { name: secretRefName } }),
  },
}),
```

with `secretRef` defaulting to `"sops-age"` — knr-ops's name, and the name `flux bootstrap`
documentation uses. The string shorthand covers the common call:

```typescript
export const api = FluxAppFor("api", {
  source,
  path: "./dist/apps/api",
  decryption: "sops",
  dependsOn: ["platform"],
});
```

The `secretRef` names a Secret in `flux-system` holding the age identity. That Secret is
bootstrap-injected and never in git, which is exactly a `referenced` declaration —
`declareSecret({ name: "sops-age", provenance: "referenced", scope: "flux-system, injected at bootstrap" })`.
The four-way taxonomy covers both halves of the SOPS story without a fifth kind.

### Interaction with the composite boundary

`FluxAppFor` must not turn decryption on by itself, and the reason is structural rather than
conservative. `spec.path` is a string naming a directory in the reconciled repo, and in the reference
project shape that directory is the output of a *different* `chant build` invocation —
`examples/flux-apps/package.json` runs four separate builds, one per path, and the Flux build is the
one that does not contain the workloads. The composite has no way to know what is at `path`, so
inferring decryption from the build it happens to be in would be right sometimes and wrong silently
the rest of the time. Explicit `decryption` is the honest surface; §5's WK8505 catches the mismatch
in the single-build case where the join is actually available.

No `kustomization.yaml` is emitted, and none is needed. Flux's kustomize-controller treats a
directory with no kustomization file as a plain manifest directory and applies every YAML it finds,
decrypting `sops`-marked documents first. This is a deliberate divergence from knr-ops, which lists
`*.sops.yaml` explicitly under `resources:` because it *has* a `kustomization.yaml`; chant's `dist`
directories do not, and the directory-scan default covers the same ground with nothing to keep in
sync. Emitting one is discussed in §7.

## 5. Lint implications

### WK8005, WK8041, WK8042 need no change

This contradicts the issue's framing, and the reason is worth stating precisely, because it is a
scoping accident that happens to be exactly right.

- WK8005 (`lexicons/k8s/src/lint/post-synth/wk8005.ts` line 26) and WK8041 (`wk8041.ts` line 43)
  both open with `if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;`.
  `WORKLOAD_KINDS` (`k8s-helpers.ts`) is `Pod`, `Deployment`, `StatefulSet`, `DaemonSet`, `Job`,
  `CronJob`. Neither rule reads `data` or `stringData` anywhere, and neither ever sees a
  `kind: Secret` document. WK8041's patterns are additionally all `^`-anchored, so `ENC[AES256_GCM,...]`
  could not match even if it reached them.
- WK8042 (`wk8042.ts` line 26) is `kind !== "ConfigMap"` → skip, looking for a literal
  `-----BEGIN ... PRIVATE KEY-----` header. SOPS replaces that header with `ENC[...]`.
- The top-level `sops` metadata block is inert to all three: `parseK8sManifests` yields it as one
  more top-level key on a document whose `kind` every one of them already skipped, and no rule in the
  lexicon iterates unknown top-level manifest keys.
- Belt and braces: all three read `getPrimaryOutput(output)`, and §3 puts the ciphertext in
  `SerializerResult.files`, which `getPrimaryOutput` does not return.

So there is no false positive to fix. There is a real gap in the other direction, though: because
post-synth checks read the primary output only, an emitted sidecar file is invisible to *every*
existing rule. New rules must read `output.files` explicitly. `PostSynthContext.outputs` is typed
`Map<string, string | SerializerResult>` (`packages/core/src/lint/post-synth.ts` line 10), so the
data is there; only `getPrimaryOutput` discards it. A `getAdditionalFiles(output)` helper alongside
it is the natural addition.

### New rules

**WK8504 — committed-encrypted declaration does not resolve.** Severity error. Fires when the
declared file is missing, unparseable, not a `v1` `Secret`, carries a `metadata.name` other than the
declared one, has no `sops` block, or has a `data`/`stringData` value that is not `ENC[...]`-shaped.
This is §3's stage-2 validation surfaced as a diagnostic rather than a thrown build error — the same
checks, reported per declaration so an author sees all of them at once. It names the file path and,
for the unencrypted-value case, the key name only.

The failure this rule exists for is the one that matters: someone edits `db-credentials.sops.yaml`
by hand, forgets `sops -e`, and commits plaintext. Today nothing in chant would notice. With the
declaration in place, the build fails.

**WK8505 — committed-encrypted secret with no Flux decryption wiring.** Severity warning. Fires when
a build contains at least one committed-encrypted declaration and at least one
`K8s::Flux::Kustomization`, and no Kustomization in that build sets `spec.decryption`. Warning rather
than error because the two halves legitimately live in separate build invocations in the reference
project shape (§4), so the rule cannot distinguish "wired up in the Flux build" from "forgotten". It
should be promoted to error if a path-to-build-target join ever becomes available.

Both need the standard registration: the check file under
`lexicons/k8s/src/lint/post-synth/`, an entry in the generated barrel `index.ts` (regenerated by
`chant generate`, not hand-edited), and an `auditRule(...)` entry in
`lexicons/k8s/src/lint/audit-catalog.ts` with the `K8S_SECRETS` authority, matching the WK8005 /
WK8041 / WK8042 rows at lines 13–16. `packages/core/src/audit/catalog.test.ts` fails CI on a rule
with no catalog entry, so this is not optional.

Note that post-synth findings have no `chant-disable` comment surface by design
(`packages/core/src/lint/post-synth.ts`, the `PostSynthDiagnostic` doc comment) — suppression for
these goes through `lint.rules` severity overrides.

### Elsewhere in the tree

COR024 (`packages/core/src/lint/rules/cor024-receipt-secret-pointer.ts`) already lists `ciphertext`
in its `MATERIAL_FIELDS` set and treats `declareSecret(...)` as a Secret-kind initializer, so a
receipt input reaching into a committed-encrypted declaration is already an error. No change, and the
rule's premise holds for the new kind as written.

Two helm rules would false-positive on SOPS ciphertext and are worth filing separately, since a helm
chart carrying a `.sops.yaml` template is a real shape: WHM503
(`lexicons/helm/src/lint/post-synth/whm503.ts`) fires on any `kind: Secret` with a populated
`data`/`stringData` map, with no value inspection at all, and WHM407 (`whm407.ts`) counts any
non-`{{`-templated `data:` value as a literal. Both are out of scope here — this design touches only
the k8s emission path — but the k8s lexicon's structural blindness to Secrets is what keeps this
feature clean, and the helm lexicon does not share it.

## 6. Two behaviours that already work

Neither needs a change; both should be stated in the implementing issue so nobody "fixes" them.

**Live diff.** `k8sDeepNormalizationHooks.mask` (`lexicons/k8s/src/deep-observe-hooks.ts` line 330)
collapses every path matching `^(?:data|stringData)\.` on a `K8s::Core::Secret` to `[REDACTED]`, on
the declared and live sides alike. So even if a ciphertext Secret did enter the observed set, the
declared `ENC[...]` and the live decrypted bytes would both mask to the same token and never surface
as drift. The masking that exists for `generated-once` covers committed-encrypted for free, and for
the same reason: a diff on a secret observes presence, key set and metadata, never values.

**Apply safety.** chant's own appliers read the primary output. Because §3 keeps the ciphertext in
`SerializerResult.files`, `kubectl-apply` and `fluxReconcile`
(`lexicons/k8s/docs/pages/flux-composites.mdx`) structurally cannot push an undecrypted Secret into a
cluster — the bytes are not in the document they read. Flux is the only thing that applies the
sidecar, and Flux decrypts first. Had the ciphertext been modelled as an ordinary entity in the
primary output, this would have been a live foot-gun: a `chant run` would apply a Secret whose values
are the literal string `ENC[AES256_GCM,...]`, the pod would start, and the failure would surface as
an application-level authentication error far from its cause.

**Prune.** A committed-encrypted Secret is not `generated-once` and must not carry the
`chant.intentius.io/generated-once` label (`lexicons/k8s/src/secret-labels.ts`). It is prunable, and
correctly so: the ciphertext in git is the source of truth and a deleted Secret is one reconcile
away from returning. The generated-once retention rule exists because the stored bytes are the only
copy of material chant never held; here they are not the only copy, so the rule does not transfer.

## 7. Out of scope

Key management. The age identity is bootstrap-injected into the cluster and never in git. chant
declares it as a `referenced` secret (§4) and stops there. No key generation, no key distribution, no
`sops-age` Secret creation.

Rotation and re-encryption. `sops -e`, `sops updatekeys`, adding or removing a recipient, and
re-encrypting after a key compromise are operator actions on a file in the repo. chant never runs
`sops`, in either direction.

Decryption, anywhere, at any stage. Not at build, not at lint, not in an Op step. The plaintext has
no representation in chant at any point in this design.

`.sops.yaml` generation. Emitting the repo-root creation rules that decide which files get encrypted
against which recipients is a separate feature with its own failure modes. This design reads the
result, not the policy.

Other encryption tools. Sealed-secrets is a controller that materialises a Secret from a
`SealedSecret` CR, which is `from-provider`, not committed-encrypted — the taxonomy already answers
it and WK8503's producer set is where support would go. `git-crypt` and `blackbox` encrypt whole
files with no in-band metadata, so there is nothing to validate; if they ever matter, they need their
own `encryption` union member and their own detection rule.

## 8. Open questions

**Should the ciphertext file be copied into the output at all, or should Flux point at its committed
location directly?** The alternative is to leave `secrets/db-credentials.sops.yaml` where it is and
have the author point a Flux `Kustomization` at `./secrets`, with chant emitting nothing.
Recommendation: copy it. Flux reconciles a path, and the workloads that consume the secret are in
`dist/apps/api`; a separate Kustomization for the secrets directory means a second reconcile edge and
an ordering problem that `dependsOn` only partly solves. Copying also makes the file visible to lint
as build output, which is what makes WK8504 possible.

**Multi-document ciphertext files.** SOPS handles multi-document YAML, and an estate may keep several
Secrets in one file. Recommendation: v1 requires a single document, refused with a clear message
otherwise. The declaration is keyed by one `name`, and either a declaration-per-document sharing a
file or a `names: string[]` field is a design change worth making deliberately, not by accident.

**Should chant record a digest of the ciphertext?** It would give the build receipt something to
compare. Recommendation: no. SOPS encryption is randomised, so re-encrypting identical plaintext
produces different bytes and a different digest — the digest would be noise as a change signal, not
information. Note also that the `sops.mac` field IS a MAC over the plaintext, so chant must never
extract, compare, or propagate it as a semantic value; copying the file verbatim carries it, which is
fine, but reading it would be a value-derived comparison and is precisely what
`where-values-come-from.mdx`'s hard-line aside forbids.

**Should `recipients` be cross-checked against the file's own `sops` block?** The file lists its
recipients in cleartext, so the check is trivially available. Recommendation: ship the field in the
API, defer the check to a follow-up. It is a genuine value-add — a file re-encrypted to a rotated
recipient without updating the declaration is a real drift — but it needs a decision about PGP
fingerprint normalisation (long vs short form, case) that is not worth blocking on.

**Should `FluxAppFor` emit a `kustomization.yaml` into the reconciled path?** knr-ops has one and
lists its `*.sops.yaml` files explicitly. Recommendation: no, for v1. Flux's directory scan already
applies every YAML in the path, so the file would add a `resources:` list to keep in sync with the
emitted set for no behavioural gain, and chant does not model kustomization files anywhere today.
Revisit if an estate needs kustomize transformers over chant output, which is a much larger feature.

**Where should the `EncryptedSecretFile` entity live in the type surface?** It is a k8s-lexicon
declarable that the k8s serializer recognises by marker, following `RenderedManifestEntity`
(`lexicons/k8s/src/kustomize/rendered-entity.ts`). Recommendation: keep it internal — not exported
from the package entry point, not directly constructible by authors. The author's surface is
`declareSecret`; the entity is an implementation detail of the resolution stage, and making it
public invites someone to construct one with inline bytes, which is the thing this whole design is
built to prevent.

**Does the k8s serializer's return-type widening break anything downstream?** `SerializerResult` is
already accepted everywhere `string` is (`packages/core/src/serializer.ts` line 93 types the union),
and `getPrimaryOutput` handles both. The risk is any k8s-specific consumer that assumes `string`.
Recommendation: the implementing issue greps for direct reads of the k8s serializer's return and
converts them, and the serializer keeps returning a bare `string` when `files` would be empty, so the
common case is byte-identical to today.

## 9. Proposed sequenced follow-up issues

Scoped so each is independently shippable, smallest blast radius first.

1. **feat(core): `committed-encrypted` provenance kind.** The fourth union member, input/declaration
   types, factory overload and validation, the `..`/absolute-path and private-key-in-`recipients`
   guards, and the taxonomy table row in `where-values-come-from.mdx`. Pure core, no lexicon change,
   no build behaviour — a declaration that nothing reads yet. Tests mirror
   `packages/core/src/secret-provenance.test.ts`.
2. **feat(core): `BuildRootContext.entities`.** Widen the context so a `buildRoots()` contributor can
   see discovered entities. One field, one call site in `build.ts`. Ships alone because it is the
   only change to a shared seam.
3. **feat(k8s): resolve and emit committed-encrypted ciphertext.** The `buildRoots()` contributor,
   the `EncryptedSecretFile` marker entity, the serializer's `SerializerResult` widening, the
   `.yaml`/`.yml` restriction, and the `--output`-required refusal. This is where the "never inlined"
   guarantee actually lands, and where the round-trip test belongs: a fixture `.sops.yaml` in,
   byte-identical file out, nothing in the primary output.
4. **feat(k8s): WK8504 + WK8503 producer branch.** The resolution rule, the producer-not-waiver
   change, `getAdditionalFiles`, barrel regeneration and catalog entries. Depends on 3 for something
   to check.
5. **feat(k8s): `FluxAppFor` decryption pass-through + WK8505.** The composite option, the
   `sops-age` default, and the missing-wiring warning. Independent of 3 and 4 in principle; sequence
   it last so the docs land against a complete feature.
6. **docs: the fourth taxonomy row, end to end.** Fill in the `committed-encrypted` row in
   `where-values-come-from.mdx`, add the primitive to
   `docs/src/content/docs/architecture/core-type-system.mdx`, document `decryption` in
   `lexicons/k8s/docs/pages/flux-composites.mdx`, and add WK8504/WK8505 to
   `lexicons/k8s/docs/pages/lint-rules.mdx`. Note that the `docs/src/content/docs/` copies under
   `lexicons/k8s/docs/` are generated — edit `pages/`.
7. **fix(helm): WHM503/WHM407 false-positive on SOPS ciphertext.** Filed separately; not on this
   critical path.

Dependencies: 3 depends on 1 and 2; 4 depends on 3; 5 is independent but sequenced last; 6 trails
everything.

## Files touched, for the implementing issues

- `packages/core/src/secret-provenance.ts` — the fourth kind (§2)
- `packages/core/src/secret-provenance.test.ts` — factory and guard coverage (§2)
- `packages/core/src/lexicon.ts` — `BuildRootContext.entities` (§3)
- `packages/core/src/build.ts` — pass entities to `buildRoots` contributors (§3)
- `packages/core/src/lint/post-synth.ts` — `getAdditionalFiles` alongside `getPrimaryOutput` (§5)
- `packages/core/src/cli/commands/build.ts` — `--output` requirement, verbatim-file follow-up (§3)
- `lexicons/k8s/src/plugin.ts` — the `buildRoots` contributor (§3)
- `lexicons/k8s/src/serializer.ts` — `SerializerResult` widening, marker routing (§3)
- `lexicons/k8s/src/composites/flux-app.ts` — `FluxAppForOptions.decryption` (§4)
- `lexicons/k8s/src/lint/post-synth/wk8503.ts` — producer branch (§2)
- `lexicons/k8s/src/lint/post-synth/wk8504.ts`, `wk8505.ts` — new checks (§5)
- `lexicons/k8s/src/lint/post-synth/index.ts` — generated barrel, via `chant generate` (§5)
- `lexicons/k8s/src/lint/audit-catalog.ts` — catalog entries (§5)
- `docs/src/content/docs/concepts/where-values-come-from.mdx` — the taxonomy row (§7 of that doc)
- `lexicons/k8s/docs/pages/flux-composites.mdx`, `lexicons/k8s/docs/pages/lint-rules.mdx` (§9.6)
