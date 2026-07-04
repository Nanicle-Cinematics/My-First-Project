'use strict';

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 128) || null;
}

function requestUserAgent(req) {
  return String(req.get('user-agent') || '').slice(0, 512) || null;
}

async function logSecurityEvent(db, req, { event, subject, actorId }) {
  if (!db || !event) return;
  try {
    await db.securityAuditLog.create({
      data: {
        event: String(event).slice(0, 100),
        subject: subject ? String(subject).slice(0, 255) : null,
        actorId: actorId || null,
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
      },
    });
  } catch (error) {
    console.error('[security-audit] failed:', error.message);
  }
}

module.exports = { logSecurityEvent, requestIp, requestUserAgent };
