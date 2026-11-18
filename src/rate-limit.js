'use strict';

/**
 * A small per-visitor rate limit. Counts are kept in memory, so they reset
 * when the app restarts; that is fine for a single small server.
 *
 * @param {{ max: number, windowMs: number }} options Requests allowed per window.
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter({ max, windowMs }) {
    const visitors = new Map();

    // Forget visitors whose window has passed.
    setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of visitors) {
            if (now > entry.resetAt) visitors.delete(ip);
        }
    }, windowMs).unref();

    return function rateLimit(req, res, next) {
        const now = Date.now();
        let entry = visitors.get(req.ip);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            visitors.set(req.ip, entry);
        }
        entry.count++;

        if (entry.count > max) {
            res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
            res.status(429).json({ error: 'Too many requests. Please pause for a few minutes and try again.' });
            return;
        }
        next();
    };
}

module.exports = { createRateLimiter };
