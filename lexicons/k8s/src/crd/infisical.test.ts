/**
 * Infisical acceptance test.
 *
 * Transcribed from fountain's `k8s/infisicalsecret.yaml`. Every field in that
 * manifest is policy — where the secret comes from, who may fetch it, what
 * happens to the materialized Secret when the CR goes away. None of it is a
 * value, which is why this kind is expressible in chant at all.
 */

import { describe, test, expect } from "vitest";
import { InfisicalSecret } from "../generated";
import { k8sSerializer } from "../serializer";
import { parseYAML } from "@intentius/chant/yaml";

function synth(logicalName: string, resource: unknown): any {
  const yaml = k8sSerializer.serialize(new Map([[logicalName, resource as never]])) as string;
  return parseYAML(yaml);
}

const fountainSecrets = new InfisicalSecret({
  metadata: { name: "fountain-secrets", namespace: "fountain", labels: { app: "fountain" } },
  spec: {
    hostAPI: "http://infisical.infisical.svc.cluster.local:8080",
    resyncInterval: 60,
    authentication: {
      kubernetesAuth: {
        identityId: "6ccf748c-7fe1-4584-a206-b0a56d84530c",
        autoCreateServiceAccountToken: true,
        serviceAccountRef: { name: "fountain-infisical", namespace: "fountain" },
        secretsScope: { projectSlug: "fountain-q-cwt", envSlug: "prod", secretsPath: "/" },
      },
    },
    managedSecretReference: {
      secretName: "fountain-secrets",
      secretNamespace: "fountain",
      creationPolicy: "Orphan",
    },
  },
});

describe("InfisicalSecret", () => {
  test("carries the Infisical apiVersion and kind", () => {
    const doc = synth("fountainSecrets", fountainSecrets);
    expect(doc.apiVersion).toBe("secrets.infisical.com/v1alpha1");
    expect(doc.kind).toBe("InfisicalSecret");
    expect(doc.metadata.name).toBe("fountain-secrets");
  });

  test("reproduces fountain's infisicalsecret.yaml", () => {
    const { spec } = synth("fountainSecrets", fountainSecrets);
    expect(spec.hostAPI).toBe("http://infisical.infisical.svc.cluster.local:8080");
    expect(spec.resyncInterval).toBe(60);
    expect(spec.managedSecretReference).toEqual({
      secretName: "fountain-secrets",
      secretNamespace: "fountain",
      creationPolicy: "Orphan",
    });
  });

  test("serializes the whole kubernetesAuth block", () => {
    const { spec } = synth("fountainSecrets", fountainSecrets);
    // Kubernetes-native auth: the point is that no credential is stored
    // anywhere. The operator presents a ServiceAccount token instead, so
    // dropping any part of this block is what turns the deployment back into
    // one that needs a secret to fetch its secrets.
    expect(spec.authentication.kubernetesAuth).toEqual({
      identityId: "6ccf748c-7fe1-4584-a206-b0a56d84530c",
      autoCreateServiceAccountToken: true,
      serviceAccountRef: { name: "fountain-infisical", namespace: "fountain" },
      secretsScope: { projectSlug: "fountain-q-cwt", envSlug: "prod", secretsPath: "/" },
    });
  });

  test("declares a source and never a value", () => {
    // The reason this CRD fits chant at all: synthesis resolves nothing here.
    // If a secret value could reach the manifest, the manifest would stop
    // being safe to commit -- so assert on the serialized text, not the props.
    const yaml = k8sSerializer.serialize(
      new Map([["fountainSecrets", fountainSecrets as never]]),
    );
    expect(yaml).not.toMatch(/\bvalue\s*:/);
    expect(yaml).not.toMatch(/\bdata\s*:/);
    expect(yaml).not.toMatch(/\bstringData\s*:/);
  });

  test("keeps resyncInterval a number", () => {
    const { spec } = synth("fountainSecrets", fountainSecrets);
    // Quoted, the operator rejects the CR rather than defaulting -- worth
    // pinning because seconds-as-a-string is a habit from other tools.
    expect(typeof spec.resyncInterval).toBe("number");
  });

  test("creationPolicy Orphan survives, since the two policies differ on deletion", () => {
    const { spec } = synth("fountainSecrets", fountainSecrets);
    // Orphan leaves the materialized Secret behind when the CR is deleted;
    // Owner takes it with it. Silently flipping to the default would make CR
    // deletion destructive.
    expect(spec.managedSecretReference.creationPolicy).toBe("Orphan");
  });
});
