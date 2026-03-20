/**
 * Docker lexicon composites.
 *
 * Composites are factory functions that return pre-configured
 * multi-resource bundles. Docker composites will be added here.
 */

// Composites deferred — see plan for Tier 2 implementation.
// Example future composites:
//   - PostgresService({ version, database, user, password }) → Service + Volume
//   - RedisService({ version, persistence }) → Service + Volume
//   - NginxService({ port, config }) → Service
