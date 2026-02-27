#!/usr/bin/env bun
/**
 * Fetch curated ARM templates from Azure Quickstart Templates for round-trip testing.
 *
 * Downloads 10 templates to testdata/azure-quickstarts/.
 * Each is validated: valid JSON, has $schema, contentVersion, resources[].
 *
 * Usage: bun run scripts/fetch-quickstart-templates.ts
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "testdata", "azure-quickstarts");

interface TemplateSpec {
  /** Short filename to save as */
  name: string;
  /** Path within Azure Quickstart Templates repo */
  repoPath: string;
}

const templates: TemplateSpec[] = [
  {
    name: "storage-account-create.json",
    repoPath: "quickstarts/microsoft.storage/storage-account-create/azuredeploy.json",
  },
  {
    name: "vnet-two-subnets.json",
    repoPath: "quickstarts/microsoft.network/vnet-two-subnets/azuredeploy.json",
  },
  {
    name: "security-group-create.json",
    repoPath: "quickstarts/microsoft.network/security-group-create/azuredeploy.json",
  },
  {
    name: "vm-simple-linux.json",
    repoPath: "quickstarts/microsoft.compute/vm-simple-linux/azuredeploy.json",
  },
  {
    name: "webapp-basic-linux.json",
    repoPath: "quickstarts/microsoft.web/webapp-basic-linux/azuredeploy.json",
  },
  {
    name: "key-vault-create.json",
    repoPath: "quickstarts/microsoft.keyvault/key-vault-create/azuredeploy.json",
  },
  {
    name: "sql-database.json",
    repoPath: "quickstarts/microsoft.sql/sql-database/azuredeploy.json",
  },
  {
    name: "cosmosdb-free.json",
    repoPath: "quickstarts/microsoft.documentdb/cosmosdb-free/azuredeploy.json",
  },
  {
    name: "public-ip-create.json",
    repoPath: "quickstarts/microsoft.network/public-ip-create/azuredeploy.json",
  },
  {
    name: "load-balancer-create.json",
    repoPath: "quickstarts/microsoft.network/internal-loadbalancer-create/azuredeploy.json",
  },
];

const BASE_URL = "https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master";

function validateTemplate(content: string, name: string): boolean {
  try {
    const parsed = JSON.parse(content);
    if (!parsed.$schema?.includes("deploymentTemplate")) {
      console.error(`  WARN: ${name} missing $schema`);
      return false;
    }
    if (!parsed.contentVersion) {
      console.error(`  WARN: ${name} missing contentVersion`);
      return false;
    }
    if (!Array.isArray(parsed.resources)) {
      console.error(`  WARN: ${name} missing resources array`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  WARN: ${name} is not valid JSON: ${err}`);
    return false;
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  let fetched = 0;
  let skipped = 0;

  for (const spec of templates) {
    const outPath = join(outDir, spec.name);

    if (existsSync(outPath)) {
      console.log(`  SKIP: ${spec.name} (already exists)`);
      skipped++;
      continue;
    }

    const url = `${BASE_URL}/${spec.repoPath}`;
    console.log(`  FETCH: ${spec.name} from ${url}`);

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`  ERROR: ${spec.name} HTTP ${resp.status}`);
        continue;
      }

      const content = await resp.text();

      if (!validateTemplate(content, spec.name)) {
        continue;
      }

      writeFileSync(outPath, content, "utf-8");
      fetched++;
      console.log(`  OK: ${spec.name} (${content.length} bytes)`);
    } catch (err) {
      console.error(`  ERROR: ${spec.name}: ${err}`);
    }
  }

  console.log(`\nDone. Fetched: ${fetched}, Skipped: ${skipped}, Total templates: ${templates.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
