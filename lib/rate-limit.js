'use strict';

function createRateLimiter({ windowMs, max, key }) {
  const buckets = new Map();
  let lastSweep = Date.now();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      lastSweep = now;
    }

    const bucketKey = key(req);
    const current = buckets.get(bucketKey);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      const message = 'Too many requests. Please wait and try again.';
      if (req.is('application/json')) return res.status(429).json({ error: message });
      return res.status(429).send(message);
    }
    next();
  };
}

module.exports = { createRateLimiter };
