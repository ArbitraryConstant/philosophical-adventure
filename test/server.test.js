// Run with: npm test
// These tests never contact Anthropic: the outgoing call is replaced with a fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.ANTHROPIC_API_KEY = 'test-key';
const { app, parseStory, validateHistory, MAX_SEGMENTS } = require('../server.js');

const realFetch = global.fetch;
let server;
let baseUrl;
let lastClaudeRequest;

// Makes the server's call to Claude return `reply` (status 200 unless given).
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

test.before(async () => {
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    global.fetch = realFetch;
    server.close();
});

test('package.json and server.js are valid and have no BOM', () => {
    for (const file of ['package.json', 'server.js', 'index.html']) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', file));
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} starts with a BOM`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.start, 'node server.js');
    assert.ok(pkg.engines.node);
});

test('parseStory reads the standard format', () => {
    const parsed = parseStory(GOOD_REPLY);
    assert.equal(parsed.story, 'You stand at the river.\n\nIt moves without effort.');
    assert.equal(parsed.concept, 'Wu wei');
    assert.deepEqual(parsed.choices, ['Step into the water', 'Follow the bank', 'Sit and watch', 'Turn back']);
});

test('parseStory tolerates markdown, brackets, spacing and letter case', () => {
    const parsed = parseStory([
        'Here is the next part.',
        '',
        '**STORY:** The path forks.',
        '## Concept: [Rhizome]',
        '**Choice 1:** Left',
        'choice2: **Right**',
        '- CHOICE3: Up',
        'CHOICE 4 : Down'
    ].join('\r\n'));
    assert.equal(parsed.story, 'The path forks.');
    assert.equal(parsed.concept, 'Rhizome');
    assert.deepEqual(parsed.choices, ['Left', 'Right', 'Up', 'Down']);
});

test('parseStory falls back to the whole text when there are no labels', () => {
    const parsed = parseStory('Just a paragraph of story.');
    assert.equal(parsed.story, 'Just a paragraph of story.');
    assert.deepEqual(parsed.choices, []);
});

test('validateHistory rejects malformed and oversized input', () => {
    assert.equal(validateHistory([]), null);
    assert.equal(validateHistory([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }]), null);
    assert.ok(validateHistory('nope'));
    assert.ok(validateHistory([{ role: 'assistant', content: 'a' }]));
    assert.ok(validateHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]));
    assert.ok(validateHistory([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'x'.repeat(5000) }]));
});

test('a new journey returns story, concept and four choices', async () => {
    fakeClaude(claudeText(GOOD_REPLY));
    const { status, body } = await generate([]);
    assert.equal(status, 200);
    assert.equal(body.concept, 'Wu wei');
    assert.equal(body.choices.length, 4);
    assert.equal(body.final, false);
    assert.equal(lastClaudeRequest.model, process.env.CLAUDE_MODEL || 'claude-sonnet-5-5');
    assert.deepEqual(lastClaudeRequest.cache_control, { type: 'ephemeral' });
    assert.equal(lastClaudeRequest.messages.length, 1);
    assert.equal(lastClaudeRequest.messages[0].role, 'user');
});

test('the full journey is sent to Claude, in alternating order', async () => {
    fakeClaude(claudeText(GOOD_REPLY));
    const history = [
        { role: 'assistant', content: GOOD_REPLY },
        { role: 'user', content: 'Sit and watch' }
    ];
    const { status } = await generate(history);
    assert.equal(status, 200);
    assert.deepEqual(lastClaudeRequest.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(lastClaudeRequest.messages[1].content, GOOD_REPLY);
    assert.match(lastClaudeRequest.messages[2].content, /Sit and watch/);
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
    assert.deepEqual(last.body.choices, []);
    assert.match(lastClaudeRequest.messages.at(-1).content, /final part of the journey/);

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

test('only the page and preview image are public', async () => {
    assert.equal((await realFetch(`${baseUrl}/`)).status, 200);
    assert.equal((await realFetch(`${baseUrl}/og-image.png`)).status, 200);
    assert.equal((await realFetch(`${baseUrl}/server.js`)).status, 404);
    assert.equal((await realFetch(`${baseUrl}/package.json`)).status, 404);
});
