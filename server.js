'use strict';

/**
 * The Way of Becoming - web server.
 *
 * Serves the game page from public/ and answers POST /api/generate, which
 * asks Claude for the next part of a reader's story.
 */

const express = require('express');
const path = require('path');

const { MODEL, ClaudeError, askClaude } = require('./src/claude');
const { createRateLimiter } = require('./src/rate-limit');
const {
    MAX_SEGMENTS,
    MAX_STORY_CHARS,
    SYSTEM_PROMPT,
    parseStory,
    validateHistory,
    segmentNumberFor,
    buildMessages
} = require('./src/story');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// The page loads its own script and styles, plus Google Fonts; nothing else.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

const app = express();

// Railway sits in front of the app; this makes req.ip the visitor's address.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY'
    });
    next();
});

app.use(express.json({ limit: '300kb' }));

// Only the files in public/ are served; the server code is not.
app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
        // Images may be cached for a week. The page, script and styles are
        // re-checked on every visit so a new deploy shows up immediately.
        const isImage = /\.(?:jpg|png|svg)$/.test(filePath);
        res.set('Cache-Control', isImage ? 'public, max-age=604800' : 'no-cache');
    }
}));

// Links shared before the preview image was converted to JPEG still work.
app.get('/og-image.png', (req, res) => {
    res.redirect(301, '/og-image.jpg');
});

// For uptime checks.
app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
});

const storyRateLimit = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

// Generate the next story segment.
app.post('/api/generate', storyRateLimit, async (req, res) => {
    try {
        const history = req.body?.history ?? [];
        const problem = validateHistory(history);
        if (problem) {
            res.status(400).json({ error: problem });
            return;
        }

        const segment = segmentNumberFor(history);
        const isFinal = segment >= MAX_SEGMENTS;

        const { text, usage } = await askClaude({
            system: SYSTEM_PROMPT,
            messages: buildMessages(history)
        });

        // Shows in the logs whether prompt caching is working: from the third
        // or fourth segment on, "cached" should be most of the input.
        console.log(
            `Segment ${segment}/${MAX_SEGMENTS} (${MODEL}): input ${usage.input_tokens ?? '?'} new`
            + ` + ${usage.cache_creation_input_tokens ?? 0} written to cache`
            + ` + ${usage.cache_read_input_tokens ?? 0} cached, output ${usage.output_tokens ?? '?'}`
        );

        const parsed = parseStory(text);
        if (!parsed.story || (!isFinal && parsed.choices.length === 0)) {
            console.error('Could not read story format from Claude response:', text.slice(0, 2000));
            res.status(502).json({ error: 'The story came back in an unexpected format. Please try again.' });
            return;
        }

        res.json({
            story: parsed.story,
            concept: parsed.concept,
            choices: isFinal ? [] : parsed.choices,
            segment,
            totalSegments: MAX_SEGMENTS,
            final: isFinal,
            // The browser sends this back as history on the next turn.
            raw: text.slice(0, MAX_STORY_CHARS)
        });
    } catch (error) {
        if (error instanceof ClaudeError) {
            console.error(`Claude request failed (model ${MODEL}): ${error.detail || error.message}`);
            res.status(error.status).json({ error: error.message });
            return;
        }
        console.error('Error in /api/generate:', error);
        res.status(500).json({ error: 'Something went wrong on the story server. Please try again.' });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Errors raised before a route runs (for example, a malformed request body).
// Express recognises an error handler by its four parameters, so `next` stays.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('Unhandled error:', err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : 'Bad request' });
});

if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (model: ${MODEL})`);
    });

    // Railway sends SIGTERM when replacing a deployment; finish requests in
    // progress instead of cutting readers off mid-story.
    process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    });
}

module.exports = { app };
