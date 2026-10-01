/**
 * AgentDashboard's rendered dashboard files for callers that pass only the
 * preset's metrics, held to a snapshot (#3045).
 *
 * The snapshot was recorded before the GenAI rules mode was added, so any
 * change to the output a `genAi`-only dashboard gets fails here.
 */
import { describe, expect, test } from "vitest";
import { genAiComponents, genAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { Datasource } from "../datasource";
import { buildGrafana } from "../build";
import { AgentDashboard } from "./agent-dashboard";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });

function files(dashboard: ReturnType<typeof AgentDashboard>["dashboard"]): Record<string, string> {
  const out = buildGrafana([prometheus, dashboard]);
  return Object.fromEntries(Object.entries(out.files).filter(([path]) => out.dashboards.some((d) => d.file === path)));
}

describe("AgentDashboard output without rules", () => {
  test("default preset", () => {
    expect(files(AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus }).dashboard)).toMatchSnapshot();
  });

  test("another namespace, quantile and dashboard options", () => {
    expect(
      files(
        AgentDashboard({
          genAi: genAiComponents({ namespace: "agents" }),
          quantile: 0.99,
          datasource: prometheus,
          title: "Agents",
          folder: "AI",
          refresh: "30s",
          tags: ["ai"],
        }).dashboard,
      ),
    ).toMatchSnapshot();
  });

  test("a preset with the conventions' client metrics and provider dimensions", () => {
    expect(
      files(AgentDashboard({ genAi: genAiMetrics({ clientMetrics: "derive", providerDimensions: true }), datasource: prometheus }).dashboard),
    ).toMatchSnapshot();
  });
});
