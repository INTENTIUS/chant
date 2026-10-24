/**
 * The kustomize, argo-app and flux-kustomization member kinds this lexicon
 * supplies to a chant workspace (#3179): data in `workspace-kinds.json`,
 * exported at `./workspace-kinds`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";
import { checkMemberFile, loadMemberFileSchema, readPackageKinds } from "../../../packages/core/src/workspace/kinds";

const packageDir = join(import.meta.dirname, "..");


const argo = "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: guestbook\nspec: {}\n";
const flux = "apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: apps\nspec: {}\n";
const kustomization = "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\n";

describeWorkspaceKindConformance({
  packageDir,
  scenarios: [
    { name: "an overlay", kind: "kustomize", files: { "kustomization.yaml": kustomization }, claims: true },
    { name: "an overlay named kustomization.yml", kind: "kustomize", files: { "kustomization.yml": kustomization }, claims: true },
    { name: "an overlay one level down", kind: "kustomize", files: { "prod/kustomization.yaml": kustomization }, claims: false },
    // A Flux Kustomization (350) outranks kustomize (340) in a directory that has both.
    { name: "a Flux Kustomization beside a kustomization.yaml", kind: "flux-kustomization", files: { "kustomization.yaml": kustomization, "sync.yaml": flux }, claims: true },
    { name: "an Argo Application", kind: "argo-app", files: { "app.yaml": argo }, claims: true },
    { name: "an Argo Application among other documents", kind: "argo-app", files: { "all.yml": "kind: ConfigMap\napiVersion: v1\n---\n" + argo }, claims: true },
    { name: "an Argo Application beside a kustomization.yaml", kind: "argo-app", files: { "kustomization.yaml": kustomization, "app.yaml": argo }, claims: true },
    { name: "a Deployment", kind: "argo-app", files: { "deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n" }, claims: false },
    { name: "an Application of another group", kind: "argo-app", files: { "app.yaml": "apiVersion: app.k8s.io/v1beta1\nkind: Application\n" }, claims: false },
    { name: "a Flux Kustomization", kind: "flux-kustomization", files: { "sync.yaml": flux }, claims: true },
    { name: "kustomize's own kustomization.yaml is not a Flux one", kind: "flux-kustomization", files: { "kustomization.yaml": kustomization }, claims: false },
    { name: "a manifest that is not YAML", kind: "flux-kustomization", files: { "sync.yaml": "{{ not: [yaml" }, claims: false },
  ],
});
