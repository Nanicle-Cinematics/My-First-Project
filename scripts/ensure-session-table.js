'use strict';
// connect-pg-simple's `createTableIfMissing` hardcodes its primary-key
// constraint name to "session_pkey" regardless of the table name — Postgres
// index/constraint names are schema-wide unique, so two DIFFERENTLY-named
// session tables created concurrently (e.g. by two test files) still race
// on that literal name. Fix: one shared table, created once, idempotently,
// via this script — never via createTableIfMissing at runtime.
const { Pool } = require('pg');
require('../lib/tenant'); // side-effect: Prisma loads .env into process.env

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    DO $$ BEGIN
      ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
  console.log('session table ready');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
