'use strict';

/**
 * Telling "the database is unreachable" apart from "this code has a bug".
 *
 * This app talks to Postgres two ways — Prisma (`rawDb`) and a raw `pg` Pool
 * (sessions, most queries) — so the same outage arrives wearing two different
 * error shapes and both have to be recognised.
 *
 * Matching is deliberately narrow. This decides whether to replace the whole
 * page with a maintenance notice, so a false positive would hide a genuine bug
 * behind a reassuring "everything is fine, come back later". Only errors that
 * mean the server is not answering count; nothing about the shape of a query,
 * a constraint, or its data.
 */

// pg surfaces network failures as Node syscall codes. Postgres' own SQLSTATEs
// are five characters, and the ones here mean "cannot start/keep a session":
// 57P01 admin shutdown, 57P02 crash shutdown, 57P03 cannot connect now,
// 53300 too many connections, 08006/08001/08003/08004 connection failures.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', '53300', '08006', '08001', '08003', '08004',
  // Prisma initialisation/connectivity codes.
  'P1000', 'P1001', 'P1002', 'P1003', 'P1010', 'P1017',
]);

const UNREACHABLE_MESSAGES = [
  // Neon stops the compute once the plan's compute-time is spent. It arrives as
  // an ordinary query error, so none of the codes above catch it — this string
  // is the only thing that identifies the outage that took the app down.
  'exceeded the compute time quota',
  'compute time quota',
  "Can't reach database server",
  'Connection terminated',
  'Connection ended unexpectedly',
  'server closed the connection unexpectedly',
  'terminating connection',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error',
  'kind: Closed',
];

function isDatabaseUnavailableError(error) {
  if (!error) return false;

  const code = error.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;

  // pg wraps the driver failure; the useful code is sometimes one level down.
  if (error.originalError && isDatabaseUnavailableError(error.originalError)) return true;
  if (error.cause && isDatabaseUnavailableError(error.cause)) return true;

  const message = String(error.message || '');
  if (!message) return false;

  return UNREACHABLE_MESSAGES.some((needle) => message.includes(needle));
}

module.exports = { isDatabaseUnavailableError };
