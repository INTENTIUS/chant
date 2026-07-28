import { describe, test, expect } from "vitest";
import { classifyOwnerChain, DEFAULT_MAX_OWNER_CHAIN_DEPTH, type OwnerChainNode } from "./owner-chain";

describe("classifyOwnerChain (#1077)", () => {
  test("owned chain reaching a declared entity → declared", () => {
    // pod -> replicaSet -> deployment (declared)
    const nodes = new Map<string, OwnerChainNode>([
      ["pod-uid", { ownerId: "rs-uid" }],
      ["rs-uid", { ownerId: "deploy-uid" }],
      ["deploy-uid", { declaredEntity: "web" }],
    ]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "declared", entity: "web" });
  });

  test("a node that is itself declared resolves immediately", () => {
    const nodes = new Map<string, OwnerChainNode>([["deploy-uid", { declaredEntity: "web" }]]);
    expect(classifyOwnerChain("deploy-uid", nodes)).toEqual({ root: "declared", entity: "web" });
  });

  test("no owner reference at all → unowned", () => {
    const nodes = new Map<string, OwnerChainNode>([["pod-uid", {}]]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "unowned" });
  });

  test("chain fully resolves to a live, undeclared root → foreign", () => {
    // pod -> replicaSet -> deployment, but the deployment is not declared
    const nodes = new Map<string, OwnerChainNode>([
      ["pod-uid", { ownerId: "rs-uid" }],
      ["rs-uid", { ownerId: "deploy-uid" }],
      ["deploy-uid", {}],
    ]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "foreign" });
  });

  test("the starting node itself could not be read → unknown", () => {
    const nodes = new Map<string, OwnerChainNode>([["pod-uid", { ownerUnreadable: true }]]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "unknown" });
  });

  test("an intermediate owner could not be read → unknown, conservative (never foreign, never declared)", () => {
    const nodes = new Map<string, OwnerChainNode>([
      ["pod-uid", { ownerId: "rs-uid" }],
      ["rs-uid", { ownerUnreadable: true }],
    ]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "unknown" });
  });

  test("an owner reference naming a node never resolved into the map → unknown", () => {
    const nodes = new Map<string, OwnerChainNode>([["pod-uid", { ownerId: "rs-uid" }]]);
    expect(classifyOwnerChain("pod-uid", nodes)).toEqual({ root: "unknown" });
  });

  test("the starting id itself is not in the map → unknown", () => {
    expect(classifyOwnerChain("nope", new Map())).toEqual({ root: "unknown" });
  });

  test("a cycle is detected and classified unknown, not an infinite loop", () => {
    const nodes = new Map<string, OwnerChainNode>([
      ["a", { ownerId: "b" }],
      ["b", { ownerId: "a" }],
    ]);
    expect(classifyOwnerChain("a", nodes)).toEqual({ root: "unknown" });
  });

  test("a self-referencing node is a cycle of one", () => {
    const nodes = new Map<string, OwnerChainNode>([["a", { ownerId: "a" }]]);
    expect(classifyOwnerChain("a", nodes)).toEqual({ root: "unknown" });
  });

  test("exceeding the depth bound is conservative unknown, not foreign", () => {
    // A straight-line chain one hop longer than the default bound, never
    // reaching a declared entity or a definite foreign root within it.
    const nodes = new Map<string, OwnerChainNode>();
    const depth = DEFAULT_MAX_OWNER_CHAIN_DEPTH + 5;
    for (let i = 0; i < depth; i++) nodes.set(`n${i}`, { ownerId: `n${i + 1}` });
    nodes.set(`n${depth}`, {}); // the true, foreign root — but out of bounds
    expect(classifyOwnerChain("n0", nodes)).toEqual({ root: "unknown" });
  });

  test("a chain exactly at the depth bound still resolves to declared", () => {
    const nodes = new Map<string, OwnerChainNode>();
    const depth = DEFAULT_MAX_OWNER_CHAIN_DEPTH;
    for (let i = 0; i < depth; i++) nodes.set(`n${i}`, { ownerId: `n${i + 1}` });
    nodes.set(`n${depth}`, { declaredEntity: "root-entity" });
    expect(classifyOwnerChain("n0", nodes)).toEqual({ root: "declared", entity: "root-entity" });
  });

  test("a custom maxDepth is honored", () => {
    const nodes = new Map<string, OwnerChainNode>([
      ["a", { ownerId: "b" }],
      ["b", { ownerId: "c" }],
      ["c", { declaredEntity: "deep" }],
    ]);
    expect(classifyOwnerChain("a", nodes, 1)).toEqual({ root: "unknown" });
    expect(classifyOwnerChain("a", nodes, 2)).toEqual({ root: "declared", entity: "deep" });
  });
});
