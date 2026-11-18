'use strict';

// Tests for the web server. Run with: npm test
// These never contact Anthropic: the outgoing call is replaced with a fake.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANTHROPIC_API_KEY = 'test-key';
const { app } = require('../server');
const { MAX_SEGMENTS } = require('../src/story');

const realFetch = global.fetch;
let server;
let baseUrl;
let lastClaudeRequest;

/** Makes the server's call to Claude return `reply` (status 200 unless given). */
function fakeClaude(reply, status = 200) {
    global.fetch = async (url, options) => {
        if (!String(url).includes('api.anthropic.com')) return realFetch(url, options);
        lastClaudeRequest = JSON.parse(options.body);
        const body = typeof reply === 'string' ? reply : JSON.stringify(reply);
        return new Response(body, { status });
    };
}

function claudeText(text, extra = {}) {
    return {
        type: 'message',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 20 },
        ...extra
    };
}

async function generate(history) {
    const response = await realFetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history })
    });
    return { status: response.status, body: await response.json() };
}

const GOOD_REPLY = `STORY: You stand at the river.

It moves without effort.
CONCEPT: Wu wei
CHOICE1: Step into the water
CHOICE2: Follow the bank
CHOICE3: Sit and watch
CHOICE4: Turn back`;

// The server logs every failure; keep the test output readable.
const realConsole = { log: console.log, warn: console.warn, error: console.error };

test.before(async () => {
    console.log = console.warn = console.error = () => {};
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    Object.assign(console, realConsole);
    global.fetch = realFetch;
    server.closeAllConnections();
    server.close();
});

test('a new journey returns story, concept, four choices and progress', async () => {
    fakeClaude(claudeText(GOOD_REPLY));
    const { status, body } = await generate([]);
    assert.equal(status, 200);
    assert.equal(body.concept, 'Wu wei');
    assert.equal(body.choices.length, 4);
    assert.equal(body.segment, 1);
    assert.equal(body.totalSegments, MAX_SEGMENTS);
    assert.equal(body.final, false);
});

test('the request to Claude uses the configured model, the prompt and caching', async () => {
    fakeClaude(claudeText(GOOD_REPLY));
    await generate([]);
    assert.equal(lastClaudeRequest.model, process.env.CLAUDE_MODEL || 'claude-sonnet-5-5');
    assert.deepEqual(lastClaudeRequest.cache_control, { type: 'ephemeral' });
    assert.match(lastClaudeRequest.system, /Deleuzean and Daoist/);
    assert.deepEqual(lastClaudeRequest.messages.map(m => m.role), ['user']);
});

test('each request repeats the previous one exactly and adds to the end (needed for caching)', async () => {
    fakeClaude(claudeText(GOOD_REPLY));
    const history = [];
    let previous = null;
    for (let turn = 0; turn < 4; turn++) {
        const { status, body } = await generate(history);
        assert.equal(status, 200);
        const sent = lastClaudeRequest;
        if (previous) {
            assert.equal(sent.system, previous.system);
            assert.deepEqual(sent.messages.slice(0, previous.messages.length), previous.messages);
        }
        previous = sent;
        history.push({ role: 'assistant', content: body.raw }, { role: 'user', content: body.choices[turn] });
    }
});

test('the last segment is an ending with no choices, and the journey then stops', async () => {
    fakeClaude(claudeText('STORY: The river reaches the sea.\nCONCEPT: The Dao'));
    const history = [];
    for (let i = 0; i < MAX_SEGMENTS - 1; i++) {
        history.push({ role: 'assistant', content: GOOD_REPLY }, { role: 'user', content: 'Sit and watch' });
    }
    const last = await generate(history);
    assert.equal(last.status, 200);
    assert.equal(last.body.final, true);
    assert.equal(last.body.segment, MAX_SEGMENTS);
    assert.deepEqual(last.body.choices, []);

    history.push({ role: 'assistant', content: 'STORY: The end.' }, { role: 'user', content: 'More' });
    const beyond = await generate(history);
    assert.equal(beyond.status, 400);
});

test('Anthropic errors are passed on as readable messages', async () => {
    fakeClaude({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529);
    const { status, body } = await generate([]);
    assert.equal(status, 529);
    assert.equal(body.error, 'Overloaded');
});

test('a non-JSON reply from Anthropic does not crash the server', async () => {
    fakeClaude('<html>Bad gateway</html>', 502);
    const { status, body } = await generate([]);
    assert.equal(status, 502);
    assert.equal(typeof body.error, 'string');
});

test('a network failure reaching Anthropic is reported, not thrown', async () => {
    global.fetch = async (url, options) => {
        if (!String(url).includes('api.anthropic.com')) return realFetch(url, options);
        throw new TypeError('fetch failed');
    };
    const { status, body } = await generate([]);
    assert.equal(status, 502);
    assert.equal(typeof body.error, 'string');
});

test('a reply with no text, a refusal, or an unreadable format is reported', async () => {
    fakeClaude({ type: 'message', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] });
    assert.equal((await generate([])).status, 502);

    fakeClaude(claudeText('', { stop_reason: 'refusal', stop_details: { category: null } }));
    assert.equal((await generate([])).status, 502);

    fakeClaude(claudeText('A story with no choices at all.'));
    assert.equal((await generate([])).status, 502);
});

test('bad requests get JSON errors, not crashes', async () => {
    const malformed = await realFetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json'
    });
    assert.equal(malformed.status, 400);
    assert.equal(typeof (await malformed.json()).error, 'string');

    const wrongShape = await generate([{ role: 'user', content: 'hello' }]);
    assert.equal(wrongShape.status, 400);
});

test('the page and its assets are public; the server code is not', async () => {
    for (const publicPath of ['/', '/app.js', '/styles.css', '/favicon.svg', '/og-image.jpg', '/robots.txt', '/healthz']) {
        assert.equal((await realFetch(baseUrl + publicPath)).status, 200, publicPath);
    }
    for (const privatePath of ['/server.js', '/package.json', '/src/story.js', '/.gitignore']) {
        assert.equal((await realFetch(baseUrl + privatePath)).status, 404, privatePath);
    }
});

test('the old preview image address redirects to the new one', async () => {
    const response = await realFetch(`${baseUrl}/og-image.png`, { redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/og-image.jpg');
});

test('responses carry security headers', async () => {
    const response = await realFetch(`${baseUrl}/`);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
});
