// Synthetic alert source — POSTs a demo alert to the webhook if it's reachable,
// otherwise starts the triage run directly. `npm run alert`.
import { describeStart, startTriage } from "./start-triage.js";
import { alertFromWebhook } from "./parse.js";

const demoBody = {
  id: `demo-${Date.now()}`,
  title: "API 5xx rate elevated in prod",
  source: "datadog",
  body: "Error rate above 5% for 5m on service api.",
};

const webhookUrl = process.env.WEBHOOK_URL ?? "http://localhost:8080/alert";

async function main(): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(demoBody),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    console.log(`sent demo alert to webhook ${webhookUrl}: ${await res.text()}`);
  } catch {
    // No webhook running — run the triage directly so the demo still works.
    const start = await startTriage(alertFromWebhook(demoBody));
    console.log(`webhook unavailable; ran the triage here: ${describeStart(start)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
