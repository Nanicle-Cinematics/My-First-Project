'use strict';

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const STRICT_SSL_MODE = 'verify-full';
const LEGACY_STRICT_ALIASES = new Set(['prefer', 'require', 'verify-ca']);

function normalizePostgresSslMode(connectionString, { strictMode = STRICT_SSL_MODE } = {}) {
  if (!connectionString) return connectionString;
  let url;
  try {
    url = new URL(connectionString);
  } catch (error) {
    return connectionString;
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) return connectionString;
  const sslmode = url.searchParams.get('sslmode');
  if (!sslmode || !LEGACY_STRICT_ALIASES.has(sslmode.toLowerCase())) return connectionString;
  url.searchParams.set('sslmode', strictMode);
  return url.toString();
}

function normalizeEnvDatabaseUrl(env = process.env) {
  if (!env.DATABASE_URL) return env.DATABASE_URL;
  env.DATABASE_URL = normalizePostgresSslMode(env.DATABASE_URL);
  return env.DATABASE_URL;
}

function getDatabaseUrl(env = process.env) {
  return normalizeEnvDatabaseUrl(env);
}

module.exports = {
  STRICT_SSL_MODE,
  normalizePostgresSslMode,
  normalizeEnvDatabaseUrl,
  getDatabaseUrl,
};
