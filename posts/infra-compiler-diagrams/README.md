# "A compiler for your manifests, in TypeScript" — LinkedIn bundle

Visual aids + copy for a standalone post about chant, aimed at the Kubernetes / GitOps audience. Angle: typed config isn't new (CUE, Dhall, KCL, Pkl, cdk8s) — chant's bet is the *combination*: a mainstream language (not a new DSL), deterministic synthesis (not executed code), and output true to the real spec. No "first/finally" claims.

Article: [`../infra-compiler.md`](../infra-compiler.md).

## Assets

Each diagram is **`.svg`** (crisp, scalable) + **`.png`** (≈2× / 200 dpi, white bg — upload the PNGs to LinkedIn; it won't take SVG). Diagrams 01 and 04 are hand-authored SVG (precise ratio control); 02 / 03 / 05 are Graphviz `.dot` → rendered.

| Order | File | Ratio | Caption / alt text |
|---|---|---|---|
| 1 (hero) | `01-infra-compiler` | 2.38:1 | The pipeline: typed TypeScript → chant → native Kubernetes YAML → the deploy and reconcile layer. A TypeScript compiler for the K8s authoring layer. |
| 2 | `02-shift-left` | 2.47:1 | A compiler moves the catch left: the same error class (typo, bad ref, invalid enum, incoherent spec) dies in the editor instead of at a 3am page. |
| 3 | `03-determinism-ladder` | 1.43:1 | Determinism by avoidance (Kustomize, by hand) vs. by enforcement (chant's EVL lint — can't be merged). |
| 4 | `04-reconcile-superset` | 2.38:1 | Opt-in lifecycle with no authoritative state file: observe → reconcile → authoritative, chosen per environment; ownership read from a live marker. |
| 5 | `05-slots-under` | 0.95:1 | chant slots under the stack — reconciler (Flux/Argo) untouched, same native YAML, walk-away cost zero. |

All ratios sit in LinkedIn's comfortable range (square 1:1 to landscape ~1.9:1; 02/03 read fine slightly wider). For a uniform carousel, 1:1 padding can be added — ask.

Re-render after editing:

```bash
cd posts/infra-compiler-diagrams
# Graphviz diagrams (02, 03, 05)
for n in 02-shift-left 03-determinism-ladder 05-slots-under; do
  dot -Tsvg -o "$n.svg" "$n.dot"; dot -Tpng -Gdpi=200 -Gbgcolor=white -o "$n.png" "$n.dot"
done
# hand-authored SVGs (01, 04)
for n in 01-infra-compiler 04-reconcile-superset; do rsvg-convert -z 2 -b white "$n.svg" -o "$n.png"; done
```

---

## LinkedIn copy

### A — Standalone post (lead with the combination)

> A GitOps pipeline on Kubernetes is full of tools. A reconciler converges the cluster. Drift gets detected and alarmed while policy engines gate what reaches the cluster.
>
> The least guarded stage is the one where the manifests get written. Hand-authored YAML patched with Kustomize and templated with Helm goes unchecked for meaning until the reconciler tries to apply it.
>
> **chant is a compiler for that layer, in TypeScript, not another DSL.**
>
> Typed TypeScript goes in and native Kubernetes YAML comes out. The build type-checks and semantic-lints and synthesizes deterministically, then stops and hands a standard manifest to the existing deploy path.
>
> Why it matters.
>
> → **TypeScript, not a new DSL.** Typed config is not new and CUE, Dhall, KCL, and Pkl all prove it. Those are languages a team adopts from scratch and cdk8s and CDK and Pulumi execute the code. chant is the TypeScript and IDE already in place and chant only synthesizes.
>
> → **Determinism by enforcement, not avoidance.** Helm calls now() and lookup and randAlphaNum and renders differently per run, so teams reach for Kustomize. chant makes determinism a build rule where non-deterministic input becomes a lint error that cannot merge.
>
> → **The catch moves left.** A bad reference or an invalid enum or a Service whose selector matches nothing dies in the editor rather than at a failed reconcile or a page.
>
> → **chant slots under the reconciler.** Standard YAML comes out, Flux and Argo stay untouched, and walk-away cost is zero because dropping chant leaves the committed manifests working.
>
> → **No authoritative state file.** Truth lives in the live system and the snapshot is only evidence for a diff. An opt-in lifecycle dial runs observe then reconcile then authoritative, chosen per environment.
>
> The operational layer was always well-tooled. The authoring layer was the gap.
>
> chant is not the first to compile config. chant is the one that compiles in a mainstream language, executes nothing, and stays true to the real spec. [attach 01 → 02 → 03 → 05; add 04 if going long]

### B — Short version (comment / teaser)

> A K8s GitOps pipeline has tooling at every stage except the one where the manifests get written. Kustomize patches YAML and Helm templates YAML and neither knows whether the result means anything until apply time. chant is a compiler for that layer in TypeScript rather than a new DSL like CUE or KCL. Typed TypeScript becomes native YAML, determinism is enforced because the evaluability lint rejects now() and lookup at build, and semantic lint catches incoherent specs in the editor. chant slots under Flux and Argo, the same YAML comes out, and walk-away cost is zero. [attach 01 + 02]

---

## Notes on tone

- **No primacy claims.** Typed config compilers exist (CUE, Dhall, KCL, Pkl, cdk8s). The post wins on the *combination* — mainstream language + deterministic synthesis + spec-true — not on being first. "TypeScript, not another DSL" is the hook; the combination is the substance.
- **Concrete to the audience.** Speaks K8s/GitOps directly: Flux, Argo, Helm, Kustomize, reconcile, drift, apply.
- **Honest about prior art.** Naming CUE/KCL/cdk8s and then differentiating reads as confidence, not evasion — and preempts the "what about X?" reply.
- **Additive, never replacement.** chant slots *under* the reconciler in every diagram; nothing the reader runs has to change.
