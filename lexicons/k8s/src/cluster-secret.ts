/**
 * Argo CD cluster Secrets as the graph reads them (#5101).
 *
 * A cluster Secret is a Secret labelled `argocd.argoproj.io/secret-type:
 * cluster`. Its `name` and `server` say which cluster it registers, and they
 * are what an Application's destination and a Terraform cluster resource are
 * joined on. They sit in `stringData`, or base64 in `data`.
 *
 * The rest of the Secret is the cluster's credentials: a bearer token, a CA
 * bundle. No graph read needs them, so {@link clusterSecretView} drops them
 * when a member reads a manifest directory.
 */
import type { DeclaredCatalogNode } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { CLUSTER_SECRET_TYPE_LABEL } from "./lint/post-synth/argo-helpers";

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether the labels of an object mark an Argo CD cluster Secret. */
function labelled(metadata: unknown): boolean {
  return isObject(metadata) && isObject(metadata.labels) && metadata.labels[CLUSTER_SECRET_TYPE_LABEL] === "cluster";
}

/** Whether a manifest document is a Secret labelled as an Argo CD cluster registration. */
export function isClusterSecretDocument(doc: Doc): boolean {
  return doc.kind === "Secret" && typeof doc.apiVersion === "string" && !doc.apiVersion.includes("/") && labelled(doc.metadata);
}

/** A string field of a cluster Secret: `stringData` when set, else `data` decoded from base64. */
function field(secret: Doc, key: string): string | undefined {
  const plain = isObject(secret.stringData) ? secret.stringData[key] : undefined;
  if (typeof plain === "string") return plain;
  const encoded = isObject(secret.data) ? secret.data[key] : undefined;
  if (typeof encoded !== "string") return undefined;
  const text = Buffer.from(encoded, "base64").toString("utf-8");
  return text.includes("\uFFFD") ? undefined : text;
}

/** The `name` and `server` a cluster Secret registers, as the ones it sets. */
export function clusterSecretJoin(secret: Doc): { name?: string; server?: string } {
  const name = field(secret, "name");
  const server = field(secret, "server");
  return { ...(name !== undefined ? { name } : {}), ...(server !== undefined ? { server } : {}) };
}

/** A cluster Secret document cut down to its metadata and the `name` and `server` in `stringData`. */
export function clusterSecretView(doc: Doc): Doc {
  return {
    apiVersion: doc.apiVersion,
    kind: doc.kind,
    metadata: doc.metadata,
    ...(doc.type !== undefined ? { type: doc.type } : {}),
    stringData: clusterSecretJoin(doc),
  };
}

/**
 * The node the catalog reads for a declared node of the k8s lexicon: a
 * cluster Secret with its `name` and `server` under `argoCluster`, decoded,
 * and nothing else of its `data`. Any other node is read as it is. Only a
 * cluster Secret has that path, so a Secret that happens to carry a
 * `stringData.name` is not read as a cluster registration.
 */
export function k8sDeclaredNode(node: IRNode): DeclaredCatalogNode | undefined {
  if (node.kind !== "K8s::Core::Secret" || !labelled(node.attrs.metadata)) return undefined;
  const { name, server } = clusterSecretJoin(node.attrs);
  const { data: _data, stringData: _stringData, ...rest } = node.attrs;
  return { kind: node.kind, attrs: { ...rest, argoCluster: { ...(name !== undefined ? { name } : {}), ...(server !== undefined ? { server } : {}) } }, nonLiteral: 0 };
}

/** Whether a node is an Argo CD cluster Secret: what a member's `runsOn` joins to the cluster resource. */
export function registersCluster(node: IRNode): boolean {
  return node.kind === "K8s::Core::Secret" && labelled(node.attrs.metadata);
}
