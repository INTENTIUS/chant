// TLS material, declared empty.
//
// Cert generation writes the versions and External Secrets syncs them into
// each cluster — see the deploy flow. One CA, one node cert covering all nine
// nodes, one client cert for root.
//
// Written out rather than mapped over CERT_SECRET_NAMES, for the same reason
// as the bindings in ./iam.ts: a `.map()` in a value position costs the stack
// its fold.

import { SecretManagerSecret } from "@intentius/chant-lexicon-gcp";
import { CERT_SECRET_NAMES } from "./config";

export const caSecret = new SecretManagerSecret({
  metadata: { name: CERT_SECRET_NAMES.ca },
  replication: { automatic: true },
});

export const nodeCrtSecret = new SecretManagerSecret({
  metadata: { name: CERT_SECRET_NAMES.nodeCrt },
  replication: { automatic: true },
});

export const nodeKeySecret = new SecretManagerSecret({
  metadata: { name: CERT_SECRET_NAMES.nodeKey },
  replication: { automatic: true },
});

export const clientRootCrtSecret = new SecretManagerSecret({
  metadata: { name: CERT_SECRET_NAMES.clientRootCrt },
  replication: { automatic: true },
});

export const clientRootKeySecret = new SecretManagerSecret({
  metadata: { name: CERT_SECRET_NAMES.clientRootKey },
  replication: { automatic: true },
});
