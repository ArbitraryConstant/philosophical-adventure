const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_TIMEOUT_MS = 120000;

// A journey is this many story segments long; the last one is an ending.
const MAX_SEGMENTS = 20;

// Limits on what a browser may send, so the endpoint can't be used as a
// general-purpose (and expensive) gateway to Claude.
const MAX_STORY_CHARS = 12000;
const MAX_CHOICE_CHARS = 600;
const RATE_LIMIT_MAX = 60;                  // requests per window, per visitor
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const SYSTEM_PROMPT = `You are a philosophical guide creating an interactive choose-your-own-adventure story that weaves together Deleuzean and Daoist concepts.

The story should explore concepts like:
- Deleuze: rhizomes, becoming, multiplicities, lines of flight, deterritorialization, the Body without Organs, smooth vs striated space, assemblages
- Daoism: wu wei (effortless action), the Dao (the Way), yin-yang, spontaneity, naturalness, emptiness, non-attachment, flow like water

Create a contemplative, philosophical narrative where the protagonist encounters situations that embody these concepts. Each scenario should present a genuine philosophical dilemma or moment of insight. Make the story poetic, evocative, and thought-provoking.

Each time the reader makes a choice, continue the story from that choice and explore the philosophical concepts deeply.

After each story segment, provide exactly 4 choices that lead to different philosophical paths. Each choice should represent a different way of engaging with the concepts (e.g., flowing vs. resisting, becoming vs. being, multiplicity vs. unity, action vs. non-action).

Format every response exactly like this, in plain text with no markdown and no square brackets:
STORY: [story text, 2-3 paragraphs]
CONCEPT: [name one key philosophical concept being explored]
CHOICE1: [first choice]
CHOICE2: [second choice]
CHOICE3: [third choice]
CHOICE4: [fourth choice]`;

const FINAL_SEGMENT_NOTE = `

This is the final part of the journey. Bring the story to a contemplative close. Use the same STORY: and CONCEPT: labels, but do not offer any choices.`;

// ---------------------------------------------------------------------------
// Reading Claude's reply
// ---------------------------------------------------------------------------

// Matches a section label at the start of a line. Tolerates markdown
// decoration ("**STORY:**", "## Story:"), any letter case, and "CHOICE 1:".
const LABEL_PATTERN = /^[ \t]*(?:[#>*_-]+[ \t]*)?(STORY|CONCEPT|CHOICE[ \t]*[1-4])[ \t]*(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*/gim;

function tidy(value) {
    let text = value.trim();
    text = text.replace(/^(?:\*\*|__)+/, '').replace(/(?:\*\*|__)+$/, '').trim();
    if (text.startsWith('[') && text.endsWith(']') && !text.slice(1, -1).includes('[')) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

// Turns Claude's labelled text into { story, concept, choices }.
function parseStory(rawText) {
    const text = String(rawText).replace(/\r\n?/g, '\n');

    const labels = [];
    LABEL_PATTERN.lastIndex = 0;
    let match;
    while ((match = LABEL_PATTERN.exec(text)) !== null) {
        labels.push({
            key: match[1].toUpperCase().replace(/[ \t]/g, ''),
            start: match.index,
            end: LABEL_PATTERN.lastIndex
        });
    }

    const sections = {};
    labels.forEach((label, i) => {
        const sectionEnd = i + 1 < labels.length ? labels[i + 1].start : text.length;
        const value = tidy(text.slice(label.end, sectionEnd));
        if (value && !(label.key in sections)) {
            sections[label.key] = value;
        }
    });

    // No STORY label: treat everything before the first label as the story.
    let story = sections.STORY;
    if (!story) {
        story = tidy(text.slice(0, labels.length ? labels[0].start : text.length));
    }

    return {
        story: story || '',
        concept: sections.CONCEPT || '',
        choices: ['CHOICE1', 'CHOICE2', 'CHOICE3', 'CHOICE4']
            .map(key => sections[key])
            .filter(Boolean)
    };
}

// ---------------------------------------------------------------------------
// Checking what the browser sent
// ---------------------------------------------------------------------------

// `history` is the journey so far: story, choice, story, choice, ...
// It is empty for a new journey and otherwise ends with the latest choice.
// Returns an error message, or null if the history is acceptable.
function validateHistory(history) {
    if (!Array.isArray(history)) {
        return 'The request was not in the expected format.';
    }
    if (history.length % 2 !== 0) {
        return 'The request was not in the expected format.';
    }
    if (history.length / 2 >= MAX_SEGMENTS) {
        return 'This journey is complete. Please begin a new path.';
    }
    for (let i = 0; i < history.length; i++) {
        const item = history[i];
        const expectedRole = i % 2 === 0 ? 'assistant' : 'user';
        const maxChars = expectedRole === 'assistant' ? MAX_STORY_CHARS : MAX_CHOICE_CHARS;
        if (!item || item.role !== expectedRole || typeof item.content !== 'string'
            || !item.content.trim() || item.content.length > maxChars) {
            return 'The request was not in the expected format.';
        }
    }
    return null;
}

function buildMessages(history, isFinal) {
    const messages = [{ role: 'user', content: 'Begin the journey.' }];
    history.forEach(item => {
        messages.push({
            role: item.role,
            content: item.role === 'user' ? `I choose: "${item.content.trim()}"` : item.content
        });
    });
    if (isFinal) {
        messages[messages.length - 1].content += FINAL_SEGMENT_NOTE;
    }
    return messages;
}

// ---------------------------------------------------------------------------
// Simple per-visitor rate limit (kept in memory; resets when the app restarts)
// ---------------------------------------------------------------------------

const requestCounts = new Map();

function rateLimit(req, res, next) {
    const now = Date.now();
    let entry = requestCounts.get(req.ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        requestCounts.set(req.ip, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Too many requests. Please pause for a few minutes and try again.' });
    }
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of requestCounts) {
        if (now > entry.resetAt) requestCounts.delete(ip);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const app = express();

// Railway sits in front of the app; this makes req.ip the visitor's address.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Only these two files are public. (Serving the whole folder would also
// publish server.js, package.json and node_modules.)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/og-image.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'og-image.png'), { maxAge: '1d' });
});

// Generate the next story segment
app.post('/api/generate', rateLimit, async (req, res) => {
    try {
        const history = (req.body && req.body.history) || [];
        const problem = validateHistory(history);
        if (problem) {
            return res.status(400).json({ error: problem });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            console.error('ANTHROPIC_API_KEY is not set');
            return res.status(500).json({ error: 'The story server is not configured (missing API key).' });
        }

        const segmentNumber = history.length / 2 + 1;
        const isFinal = segmentNumber >= MAX_SEGMENTS;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: MODEL,
                // Current models think before answering, and that thinking counts
                // against this limit, so it needs room beyond the story itself.
                max_tokens: 16000,
                // Prompt caching: the story so far is re-sent on every turn, and
                // this lets Claude re-read it at a fraction of the normal price.
                // It only works while each request repeats the previous one
                // exactly and then adds to the end, so never rewrite earlier turns.
                cache_control: { type: 'ephemeral' },
                system: SYSTEM_PROMPT,
                messages: buildMessages(history, isFinal)
            }),
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });

        // Read the body as text first so a non-JSON reply can't crash us.
        const rawBody = await response.text();
        let data = null;
        try {
            data = JSON.parse(rawBody);
        } catch (parseError) {
            data = null;
        }

        if (!response.ok || !data || data.type === 'error' || data.error) {
            console.error(
                `Anthropic API error (status ${response.status}, model ${MODEL}):`,
                rawBody.slice(0, 2000)
            );
            const message = (data && data.error && data.error.message)
                || `Claude API request failed (status ${response.status})`;
            return res.status(response.ok ? 502 : response.status).json({ error: message });
        }

        if (data.stop_reason === 'refusal') {
            console.error('Claude declined the request:', JSON.stringify(data.stop_details || {}));
            return res.status(502).json({ error: 'Claude declined to continue this story. Please try again.' });
        }

        // The reply is a list of blocks (thinking, text, ...). Join the text ones.
        const text = (Array.isArray(data.content) ? data.content : [])
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('')
            .trim();

        if (!text) {
            console.error(
                `No text in Claude response (stop_reason ${data.stop_reason}):`,
                JSON.stringify(data).slice(0, 2000)
            );
            return res.status(502).json({ error: 'Claude returned an empty reply. Please try again.' });
        }

        if (data.stop_reason === 'max_tokens') {
            console.warn('Claude response was cut off at max_tokens');
        }

        // Shows in the Railway logs whether caching is working: from the third
        // or fourth segment on, "cached" should be most of the input.
        const usage = data.usage || {};
        console.log(
            `Segment ${segmentNumber}/${MAX_SEGMENTS} (${MODEL}): input ${usage.input_tokens ?? '?'} new + ${usage.cache_creation_input_tokens ?? 0} written to cache + ${usage.cache_read_input_tokens ?? 0} cached, output ${usage.output_tokens ?? '?'}`
        );

        const parsed = parseStory(text);
        if (!parsed.story || (!isFinal && parsed.choices.length === 0)) {
            console.error('Could not read story format from Claude response:', text.slice(0, 2000));
            return res.status(502).json({ error: 'The story came back in an unexpected format. Please try again.' });
        }

        res.json({
            story: parsed.story,
            concept: parsed.concept,
            choices: isFinal ? [] : parsed.choices,
            final: isFinal,
            // The browser sends this back as history on the next turn.
            raw: text.slice(0, MAX_STORY_CHARS)
        });

    } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            console.error(`Anthropic API request timed out after ${API_TIMEOUT_MS} ms`);
            return res.status(504).json({ error: 'Claude took too long to respond. Please try again.' });
        }
        console.error('Error in /api/generate:', error);
        res.status(500).json({ error: 'Something went wrong on the story server. Please try again.' });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Errors raised before a route runs (for example, a malformed request body).
app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('Unhandled error:', err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : 'Bad request' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (model: ${MODEL})`);
    });
}

module.exports = { app, parseStory, validateHistory, buildMessages, MAX_SEGMENTS };
