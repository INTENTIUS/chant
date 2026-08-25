import { describe, test, expect } from "vitest";
import { emitYAML } from "@intentius/chant/yaml";
import { VllmServingRuntime } from "./vllm-serving-runtime";

/** Helper to access props on a Declarable member. */
function p(member: unknown): Record<string, unknown> {
  return (member as any).props;
}

describe("VllmServingRuntime", () => {
  test("emits a namespaced ServingRuntime by default", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
    });
    const props = p(result.servingRuntime);
    expect(props.metadata).toMatchObject({ name: "vllm-runtime", namespace: "models" });
  });

  test("emits a ClusterServingRuntime when clusterScoped is true", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      clusterScoped: true,
      image: "vllm/vllm-openai:v0.7.0",
    });
    const props = p(result.servingRuntime);
    expect(props.metadata).toMatchObject({ name: "vllm-runtime" });
    expect((props.metadata as any).namespace).toBeUndefined();
  });

  test("throws when namespace is missing and clusterScoped is false", () => {
    expect(() =>
      VllmServingRuntime({
        name: "vllm-runtime",
        image: "vllm/vllm-openai:v0.7.0",
      } as any),
    ).toThrow(/namespace is required/);
  });

  test("registers the vllm supportedModelFormats entry", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.supportedModelFormats).toEqual([{ name: "vllm", autoSelect: true }]);
  });

  test("supports overriding the model format", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      modelFormat: { name: "vllm", version: "1", priority: 1 },
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.supportedModelFormats).toEqual([{ name: "vllm", version: "1", priority: 1 }]);
  });

  // ── Golden test: vLLM args are spec-true (real `vllm serve` flag names) ──

  test("wires typed vLLM props to real container args, in flag order", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      tensorParallelSize: 2,
      maxModelLen: 8192,
      dtype: "bfloat16",
      quantization: "awq",
      gpuMemoryUtilization: 0.9,
      maxNumSeqs: 256,
    });
    const spec = p(result.servingRuntime).spec as any;
    const container = spec.containers[0];
    expect(container.name).toBe("kserve-container");
    expect(container.command).toEqual(["vllm", "serve", "/mnt/models"]);
    expect(container.args).toEqual([
      "--tensor-parallel-size", "2",
      "--max-model-len", "8192",
      "--dtype", "bfloat16",
      "--quantization", "awq",
      "--gpu-memory-utilization", "0.9",
      "--max-num-seqs", "256",
    ]);
  });

  test("containerArgs escape hatch appends after typed flags", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      tensorParallelSize: 1,
      containerArgs: ["--enable-prefix-caching", "--disable-log-requests"],
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.containers[0].args).toEqual([
      "--tensor-parallel-size", "1",
      "--enable-prefix-caching",
      "--disable-log-requests",
    ]);
  });

  test("omits unset vLLM flags rather than emitting empty/undefined args", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.containers[0].args).toEqual([]);
  });

  test("GPU count maps to nvidia.com/gpu in resource requests and limits", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      resources: { cpu: "8", memory: "32Gi", gpu: 2 },
    });
    const spec = p(result.servingRuntime).spec as any;
    const resources = spec.containers[0].resources;
    expect(resources).toEqual({
      requests: { cpu: "8", memory: "32Gi", "nvidia.com/gpu": "2" },
      limits: { cpu: "8", memory: "32Gi", "nvidia.com/gpu": "2" },
    });
  });

  test("resources is omitted entirely when not provided", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.containers[0].resources).toBeUndefined();
  });

  test("serializes to valid YAML", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      tensorParallelSize: 2,
      resources: { cpu: "8", memory: "32Gi", gpu: 2 },
    });
    const yaml = emitYAML(p(result.servingRuntime), 0);
    expect(yaml).toContain("vllm-runtime");
    expect(yaml).toContain("tensor-parallel-size");
    expect(yaml).not.toContain("[object Object]");
  });

  test("defaults.servingRuntime passthrough merges into the resource", () => {
    const result = VllmServingRuntime({
      name: "vllm-runtime",
      namespace: "models",
      image: "vllm/vllm-openai:v0.7.0",
      defaults: {
        servingRuntime: { spec: { replicas: 3 } },
      },
    });
    const spec = p(result.servingRuntime).spec as any;
    expect(spec.replicas).toBe(3);
  });
});
