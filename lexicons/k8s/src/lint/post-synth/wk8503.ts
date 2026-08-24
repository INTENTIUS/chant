/**
 * WK8503: Workload consumes a Secret nothing in the output produces
 *
 * A pod that references a Secret which no manifest in the same build creates
 * passes `chant build`, passes `chant lint`, applies cleanly — and then fails
 * at pod start with `CreateContainerConfigError` (chant #1382). This check
 * closes that gap with the same cross-resource bundle-join ARGO003 uses: every
 * secret reference in a pod spec (envFrom.secretRef, env valueFrom
 * secretKeyRef, secret volumes, projected secret sources, imagePullSecrets)
 * must resolve to a Secret the output produces.
 *
 * Producers are the Secret manifests themselves plus the secret-materializing
 * CRs the lexicon knows: `ExternalSecret` (spec.target.name, defaulting to the
 * CR's own name), `InfisicalSecret` / `InfisicalDynamicSecret`
 * (spec.managedSecretReference.secretName — its secretNamespace is honored
 * separately from the CR's metadata.namespace), and cert-manager
 * `Certificate` (spec.secretName). Namespaces must be compatible; a side with
 * no namespace matches any.
 *
 * The typed waiver is a `SecretProvenance` declaration (chant #1828, epic
 * #1365): a `declareSecret({ name, provenance: "referenced" | "from-provider"
 * | "generated-once" })` covering the secret's name says the estate knows
 * where the value comes from, and silences the check. That is what lets this
 * ship at error severity with no suppression comment — a secret minted out of
 * band is declared, not ignored. References marked `optional: true` are
 * skipped (the author already said it may not exist).
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { collectSecretDeclarations } from "@intentius/chant/secret-provenance";
import { extractPodSpec, type K8sManifest } from "./k8s-helpers";
import { allManifests } from "./argo-helpers";

/** A Secret some manifest in the output materializes. */
interface ProducedSecret {
  name: string;
  namespace?: string;
}

/** One secret reference found in a pod spec. */
interface SecretRef {
  name: string;
  /** Which field referenced it, for the message (e.g. "envFrom.secretRef"). */
  via: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collect every Secret the output produces, from literal Secrets and the
 * secret-materializing CR kinds the lexicon ships. */
function collectProducedSecrets(manifests: K8sManifest[]): ProducedSecret[] {
  const produced: ProducedSecret[] = [];
  for (const m of manifests) {
    const metaName = m.metadata?.name;
    const metaNs = m.metadata?.namespace;
    switch (m.kind) {
      case "Secret": {
        if (typeof metaName === "string") produced.push({ name: metaName, namespace: metaNs });
        break;
      }
      case "ExternalSecret": {
        // external-secrets.io — writes spec.target.name, defaulting to the CR's own name.
        const target = asRecord(m.spec?.target);
        const targetName = typeof target?.name === "string" ? target.name : metaName;
        if (typeof targetName === "string") produced.push({ name: targetName, namespace: metaNs });
        break;
      }
      case "InfisicalSecret":
      case "InfisicalDynamicSecret": {
        // secrets.infisical.com — writes spec.managedSecretReference.secretName;
        // secretNamespace is carried separately from the CR's own namespace.
        const ref = asRecord(m.spec?.managedSecretReference);
        if (typeof ref?.secretName === "string") {
          const ns = typeof ref.secretNamespace === "string" ? ref.secretNamespace : metaNs;
          produced.push({ name: ref.secretName, namespace: ns });
        }
        break;
      }
      case "Certificate": {
        // cert-manager — materializes the keypair into spec.secretName.
        const secretName = m.spec?.secretName;
        if (typeof secretName === "string") produced.push({ name: secretName, namespace: metaNs });
        break;
      }
    }
  }
  return produced;
}

/** Collect every non-optional secret reference in a pod spec. */
function collectSecretRefs(podSpec: Record<string, unknown>): SecretRef[] {
  const refs: SecretRef[] = [];

  const containers = [
    ...asArray(podSpec.containers),
    ...asArray(podSpec.initContainers),
    ...asArray(podSpec.ephemeralContainers),
  ];
  for (const c of containers) {
    const container = asRecord(c);
    if (!container) continue;
    for (const e of asArray(container.envFrom)) {
      const secretRef = asRecord(asRecord(e)?.secretRef);
      if (typeof secretRef?.name === "string" && secretRef.optional !== true) {
        refs.push({ name: secretRef.name, via: "envFrom.secretRef" });
      }
    }
    for (const e of asArray(container.env)) {
      const keyRef = asRecord(asRecord(asRecord(e)?.valueFrom)?.secretKeyRef);
      if (typeof keyRef?.name === "string" && keyRef.optional !== true) {
        refs.push({ name: keyRef.name, via: "env[].valueFrom.secretKeyRef" });
      }
    }
  }

  for (const v of asArray(podSpec.volumes)) {
    const volume = asRecord(v);
    if (!volume) continue;
    const secret = asRecord(volume.secret);
    if (typeof secret?.secretName === "string" && secret.optional !== true) {
      refs.push({ name: secret.secretName, via: "volumes[].secret.secretName" });
    }
    const projected = asRecord(volume.projected);
    for (const s of asArray(projected?.sources)) {
      const source = asRecord(asRecord(s)?.secret);
      if (typeof source?.name === "string" && source.optional !== true) {
        refs.push({ name: source.name, via: "volumes[].projected.sources[].secret" });
      }
    }
  }

  for (const p of asArray(podSpec.imagePullSecrets)) {
    const pull = asRecord(p);
    if (typeof pull?.name === "string") {
      refs.push({ name: pull.name, via: "imagePullSecrets" });
    }
  }

  return refs;
}

/** True when a produced Secret satisfies a reference. A side with no
 * namespace matches any — only two explicit, different namespaces miss. */
function producerCovers(producer: ProducedSecret, name: string, namespace: string | undefined): boolean {
  if (producer.name !== name) return false;
  return producer.namespace === undefined || namespace === undefined || producer.namespace === namespace;
}

export const wk8503: PostSynthCheck = {
  id: "WK8503",
  description:
    "Workload consumes a Secret nothing in the output produces — produce it (Secret, ExternalSecret, InfisicalSecret, Certificate) or declare its provenance with declareSecret()",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const manifests = allManifests(ctx);
    const produced = collectProducedSecrets(manifests);

    // The typed waiver: any SecretProvenance declaration covering the name.
    const declaredNames = new Set<string>();
    for (const decl of collectSecretDeclarations(ctx.entities).values()) {
      declaredNames.add(decl.name);
    }

    for (const manifest of manifests) {
      const podSpec = extractPodSpec(manifest);
      if (!podSpec) continue;
      const workload = manifest.metadata?.name ?? manifest.kind ?? "workload";
      const namespace = manifest.metadata?.namespace;

      const reported = new Set<string>();
      for (const ref of collectSecretRefs(podSpec)) {
        if (reported.has(ref.name)) continue;
        if (declaredNames.has(ref.name)) continue;
        if (produced.some((p) => producerCovers(p, ref.name, namespace))) continue;
        reported.add(ref.name);
        diagnostics.push({
          checkId: "WK8503",
          severity: "error",
          message:
            `${manifest.kind} "${workload}" consumes Secret "${ref.name}" (via ${ref.via}), ` +
            `but nothing in the build output produces it — the pod will fail at start. ` +
            `Produce it in this build, or declare its provenance: ` +
            `declareSecret({ name: "${ref.name}", provenance: "referenced" }).`,
          entity: workload,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
