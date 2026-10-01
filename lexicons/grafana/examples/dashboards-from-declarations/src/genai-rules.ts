/**
 * Recording rules over the GenAI preset's metrics, with cost from a price
 * table. `groupBy: ["service_name"]` keeps the service on every recorded
 * series, so the dashboard that reads them can offer a service picker.
 *
 * The prices are made up for the example. The lexicon ships none: read
 * them from each provider's pricing page and record where and when.
 */
import { GenAiRules } from "@intentius/chant-lexicon-prometheus";
import { genai } from "./components";

const genaiRules = GenAiRules({
  genAi: genai,
  groupBy: ["service_name"],
  prices: [
    { provider: "anthropic", model: "big", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com/pricing", asOf: "2026-09-29" },
    { provider: "mistral", model: "small", inputPerMTok: 1, outputPerMTok: 4, currency: "EUR", source: "https://example.com/pricing", asOf: "2026-09-29" },
  ],
  alerts: { errorRatio: true },
});

export { genaiRules };
