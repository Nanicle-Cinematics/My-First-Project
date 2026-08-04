'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePostgresSslMode } = require('../lib/database-url');

test('normalizePostgresSslMode tightens legacy strict aliases to verify-full', () => {
  assert.equal(
    normalizePostgresSslMode('postgresql://user:pass@example.com/db?sslmode=require'),
    'postgresql://user:pass@example.com/db?sslmode=verify-full',
  );
  assert.equal(
    normalizePostgresSslMode('postgres://user:pass@example.com/db?sslmode=prefer&connect_timeout=10'),
    'postgres://user:pass@example.com/db?sslmode=verify-full&connect_timeout=10',
  );
});

test('normalizePostgresSslMode leaves explicit non-legacy modes and non-Postgres URLs alone', () => {
  assert.equal(
    normalizePostgresSslMode('postgresql://user:pass@example.com/db?sslmode=disable'),
    'postgresql://user:pass@example.com/db?sslmode=disable',
  );
  assert.equal(
    normalizePostgresSslMode('sqlite:///tmp/church.db?sslmode=require'),
    'sqlite:///tmp/church.db?sslmode=require',
  );
});
