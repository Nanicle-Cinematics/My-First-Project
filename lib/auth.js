'use strict';
// Postgres/Prisma-backed auth for the multi-tenant rewrite. Login identifier
// is `email` (globally unique across ALL churches, mirrors poultry-manager) —
// NOT `username`, which stays per-church/non-unique for display only.
//
// This module is deliberately NOT wired into server.js's live request path
// yet: server.js's current auth gate (session.userId -> SQLite users table)
// keeps working unchanged for the existing production church, whose data
// hasn't been migrated to Postgres yet (that's Phase 7). Flipping the live
// gate over happens once that migration runs — doing it earlier would strand
// the real church, which only exists in SQLite today.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./tenant');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Authenticate an email + password, enforcing account lockout. Returns a
 * generic "invalid" outcome for unknown accounts and wrong passwords alike
 * so callers can avoid leaking which emails exist.
 * Uses the RAW (unscoped) client — the church isn't known until the user is
 * resolved by email.
 */
async function authenticate(email, password) {
  const user = await db.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || user.deletedAt || !user.passwordHash) return { status: 'invalid' };

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { status: 'locked', until: user.lockedUntil };
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const attempts = user.failedAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    const until = new Date(Date.now() + LOCK_DURATION_MS);
    await db.user.update({
      where: { id: user.id },
      // On lock, reset the counter so a fresh streak starts once it expires.
      data: { failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? until : null },
    });
    return lock ? { status: 'locked', until } : { status: 'invalid' };
  }

  if (user.failedAttempts > 0 || user.lockedUntil) {
    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
  }
  return { status: 'ok', user };
}

/** Resolve the signed-in user for a request whose session carries userId, or null. */
async function resolveSessionUser(req) {
  const userId = req.session && req.session.userId;
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { church: { select: { name: true } } },
  });
  if (!user || user.deletedAt) return null;
  return user;
}

function createSession(req, userId) {
  req.session.userId = userId;
}

function destroySession(req, cb) {
  req.session.destroy(cb);
}

/**
 * Issue a password reset token for the given email. Returns null if no
 * account matches (callers should show the same "if that email exists..."
 * message either way, to avoid leaking which emails are registered).
 * Real email delivery isn't wired into this stack yet (see the
 * communications module's dry-run deferral) — the caller is responsible
 * for surfacing the returned token/link to the requester directly.
 */
async function createPasswordResetToken(email) {
  const user = await db.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || user.deletedAt) return null;
  const token = crypto.randomBytes(32).toString('hex');
  await db.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
  await db.passwordResetToken.create({
    data: { churchId: user.churchId, userId: user.id, token, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  return { token, user };
}

/** Look up a live (unexpired, unused) reset token, or null. */
async function findValidResetToken(token) {
  const row = await db.passwordResetToken.findUnique({ where: { token } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

/** Consume a reset token and set the new password. Throws if the token is invalid/expired/used. */
async function resetPasswordWithToken(token, newPassword) {
  const row = await findValidResetToken(token);
  if (!row) throw new Error('This reset link is invalid or has expired.');
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.$transaction([
    db.user.update({ where: { id: row.userId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } }),
    db.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
}

module.exports = {
  authenticate, resolveSessionUser, createSession, destroySession,
  createPasswordResetToken, findValidResetToken, resetPasswordWithToken,
};
