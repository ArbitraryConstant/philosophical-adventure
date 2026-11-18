'use strict';

// Tests for reading Claude's replies and checking what browsers send.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_SEGMENTS,
    MAX_CHOICE_CHARS,
    parseStory,
    validateHistory,
    buildMessages
} = require('../src/story');

const story = { role: 'assistant', content: 'STORY: A story.' };
const choice = { role: 'user', content: 'A choice' };

test('parseStory reads the standard format', () => {
    const parsed = parseStory([
        'STORY: You stand at the river.',
        '',
        'It moves without effort.',
        'CONCEPT: Wu wei',
        'CHOICE1: Step into the water',
        'CHOICE2: Follow the bank',
        'CHOICE3: Sit and watch',
        'CHOICE4: Turn back'
    ].join('\n'));
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
    assert.equal(parsed.concept, '');
    assert.deepEqual(parsed.choices, []);
});

test('parseStory caps choices so they can always be sent back', () => {
    const parsed = parseStory(`STORY: A story.\nCHOICE1: ${'x'.repeat(MAX_CHOICE_CHARS * 2)}`);
    assert.equal(parsed.choices[0].length, MAX_CHOICE_CHARS);
    assert.equal(validateHistory([story, { role: 'user', content: parsed.choices[0] }]), null);
});

test('validateHistory accepts a new journey and well-formed turns', () => {
    assert.equal(validateHistory([]), null);
    assert.equal(validateHistory([story, choice]), null);
    assert.equal(validateHistory([story, choice, story, choice]), null);
});

test('validateHistory rejects malformed, misordered and oversized input', () => {
    assert.ok(validateHistory('nope'));
    assert.ok(validateHistory(null));
    assert.ok(validateHistory([story]));
    assert.ok(validateHistory([choice, story]));
    assert.ok(validateHistory([story, { role: 'user', content: '   ' }]));
    assert.ok(validateHistory([story, { role: 'user', content: 42 }]));
    assert.ok(validateHistory([story, { role: 'user', content: 'x'.repeat(MAX_CHOICE_CHARS + 1) }]));
    assert.ok(validateHistory([story, null]));
});

test('validateHistory stops a journey after the last segment', () => {
    const full = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) full.push(story, choice);
    assert.match(validateHistory(full), /complete/);
});

test('buildMessages alternates turns and quotes the reader\'s choices', () => {
    const messages = buildMessages([story, choice]);
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(messages[1].content, story.content);
    assert.equal(messages[2].content, 'I choose: "A choice"');
});

test('buildMessages asks for an ending only on the last segment', () => {
    const history = [];
    for (let i = 0; i < MAX_SEGMENTS - 2; i++) history.push(story, choice);
    assert.doesNotMatch(buildMessages(history).at(-1).content, /final part of the journey/);

    history.push(story, choice);
    assert.match(buildMessages(history).at(-1).content, /final part of the journey/);
});
