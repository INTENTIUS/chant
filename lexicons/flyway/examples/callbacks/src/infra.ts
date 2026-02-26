// Lifecycle callbacks project: beforeMigrate, afterMigrate, afterMigrateError
// hooks for audit logging and Slack notifications. Demonstrates FlywayConfig
// with callbackLocations, BlueprintMigrationSet composite, and CallbackEvent enum.

import {
  FlywayProject,
  FlywayConfig,
  Environment,
  BlueprintMigrationSet,
  CallbackEvent,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  name: "notification-service",
});

export const config = new FlywayConfig({
  defaultSchema: "public",
  locations: ["filesystem:sql/versioned"],
  callbackLocations: ["filesystem:sql/callbacks"],
  databaseType: "postgresql",
  validateMigrationNaming: true,
  cleanDisabled: true,
});

export const devEnv = new Environment({
  displayName: "dev",
  url: "jdbc:postgresql://localhost:5432/notifications_dev",
  schemas: ["public"],
  provisioner: "clean",
});

export const prodEnv = new Environment({
  displayName: "prod",
  url: "jdbc:postgresql://prod-notifications.internal:5432/notifications",
  schemas: ["public"],
});

// Blueprint for versioned migrations and SQL callback scripts.
// The callback file names follow Flyway convention: <event>.sql
export const { migrations, callbacks } = BlueprintMigrationSet({
  versions: [
    { version: "1", description: "Create notifications table" },
    { version: "2", description: "Add delivery status tracking" },
    { version: "3", description: "Create notification templates table" },
    { version: "4", description: "Add retry queue" },
  ],
  callbacks: [
    CallbackEvent.beforeMigrate,
    CallbackEvent.afterMigrate,
    CallbackEvent.afterMigrateError,
    CallbackEvent.beforeValidate,
    CallbackEvent.afterClean,
  ],
});
