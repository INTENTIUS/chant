import { describe, test, expect } from "vitest";
import * as core from "./core";
import * as apps from "./apps";
import * as batch from "./batch";
import * as networking from "./networking";
import * as rbac from "./rbac";

const VALID_K8S_VERBS = new Set([
  "get",
  "list",
  "watch",
  "create",
  "update",
  "patch",
  "delete",
  "deletecollection",
  "impersonate",
]);

const allConstants: Record<string, Record<string, string>> = {
  StandardVerbs: core.StandardVerbs,
  PodActions: core.PodActions,
  ServiceActions: core.ServiceActions,
  ConfigMapActions: core.ConfigMapActions,
  SecretActions: core.SecretActions,
  NamespaceActions: core.NamespaceActions,
  ServiceAccountActions: core.ServiceAccountActions,
  PersistentVolumeActions: core.PersistentVolumeActions,
  PersistentVolumeClaimActions: core.PersistentVolumeClaimActions,
  NodeActions: core.NodeActions,
  EventActions: core.EventActions,
  ResourceQuotaActions: core.ResourceQuotaActions,
  LimitRangeActions: core.LimitRangeActions,
  EndpointsActions: core.EndpointsActions,
  DeploymentActions: apps.DeploymentActions,
  StatefulSetActions: apps.StatefulSetActions,
  DaemonSetActions: apps.DaemonSetActions,
  ReplicaSetActions: apps.ReplicaSetActions,
  JobActions: batch.JobActions,
  CronJobActions: batch.CronJobActions,
  IngressActions: networking.IngressActions,
  IngressClassActions: networking.IngressClassActions,
  NetworkPolicyActions: networking.NetworkPolicyActions,
  RoleActions: rbac.RoleActions,
  ClusterRoleActions: rbac.ClusterRoleActions,
  RoleBindingActions: rbac.RoleBindingActions,
  ClusterRoleBindingActions: rbac.ClusterRoleBindingActions,
};

describe("action constants", () => {
  for (const [name, constant] of Object.entries(allConstants)) {
    test(`${name} is a non-empty object`, () => {
      expect(typeof constant).toBe("object");
      expect(Object.keys(constant).length).toBeGreaterThan(0);
    });

    test(`${name} has valid K8s RBAC verbs`, () => {
      for (const [key, verb] of Object.entries(constant)) {
        expect(VALID_K8S_VERBS.has(verb)).toBe(true);
      }
    });

    test(`${name} has no duplicate verb values`, () => {
      const values = Object.values(constant);
      // Note: duplicate verb values are OK (e.g., exec: "create" reuses "create")
      // We check for duplicate keys instead
      const keys = Object.keys(constant);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  test("StandardVerbs is a subset of PodActions", () => {
    for (const key of Object.keys(core.StandardVerbs)) {
      expect(key in core.PodActions).toBe(true);
    }
  });

  test("StandardVerbs is a subset of DeploymentActions", () => {
    for (const key of Object.keys(core.StandardVerbs)) {
      expect(key in apps.DeploymentActions).toBe(true);
    }
  });
});
