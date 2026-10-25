/**
 * edge: the ranges it lets through, the upstream it routes to, which is app
 * on the port app listens on, and the subnet app's worker is in.
 */
import { Sub, Ref, SsmParameter } from "@intentius/chant-lexicon-aws";
import { edgeListenerPort, edgeWorkerSubnetId } from "./params";

export const allowlist = new SsmParameter({
  Name: "/chant-compose/allowlist",
  Type: "String",
  Value: "10.0.1.0/24,10.0.2.0/24",
});

export const upstream = new SsmParameter({
  Name: "/chant-compose/upstream",
  Type: "String",
  Value: Sub`http://app:${Ref(edgeListenerPort)}`,
});

export const workerSubnet = new SsmParameter({
  Name: "/chant-compose/worker-subnet",
  Type: "String",
  Value: Ref(edgeWorkerSubnetId),
});
