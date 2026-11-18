'use strict';

/**
 * The story itself: the prompt given to Claude, the rules for what a browser
 * may send, and the code that reads Claude's reply.
 */

/** A journey is this many story segments long; the last one is an ending. */
const MAX_SEGMENTS = 20;

/** Size limits on what a browser may send (and on what we send it). */
const MAX_STORY_CHARS = 12000;
const MAX_CHOICE_CHARS = 600;

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

const CHOICE_KEYS = ['CHOICE1', 'CHOICE2', 'CHOICE3', 'CHOICE4'];

// A section label at the start of a line. Tolerates markdown decoration
// ("**STORY:**", "## Story:"), any letter case, and "CHOICE 1:".
const LABEL_PATTERN = /^[ \t]*(?:[#>*_-]+[ \t]*)?(STORY|CONCEPT|CHOICE[ \t]*[1-4])[ \t]*(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*/gim;

/** Trims a section and strips stray markdown emphasis or wrapping brackets. */
function tidy(value) {
    let text = value.trim();
    text = text.replace(/^(?:\*\*|__)+/, '').replace(/(?:\*\*|__)+$/, '').trim();
    if (text.startsWith('[') && text.endsWith(']') && !text.slice(1, -1).includes('[')) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

/**
 * Turns Claude's labelled text into its parts.
 *
 * @param {string} rawText
 * @returns {{ story: string, concept: string, choices: string[] }}
 */
function parseStory(rawText) {
    const text = String(rawText).replace(/\r\n?/g, '\n');

    const labels = [];
    for (const match of text.matchAll(LABEL_PATTERN)) {
        labels.push({
            key: match[1].toUpperCase().replace(/[ \t]/g, ''),
            start: match.index,
            end: match.index + match[0].length
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
    const story = sections.STORY
        || tidy(text.slice(0, labels.length ? labels[0].start : text.length));

    return {
        story,
        concept: sections.CONCEPT || '',
        // Capped so a choice can always be sent back as part of the history.
        choices: CHOICE_KEYS
            .map(key => sections[key])
            .filter(Boolean)
            .map(choice => choice.slice(0, MAX_CHOICE_CHARS).trim())
    };
}

/**
 * Checks the journey a browser sent: story, choice, story, choice, ...
 * It is empty for a new journey and otherwise ends with the latest choice.
 *
 * @param {unknown} history
 * @returns {string | null} A message for the reader, or null if acceptable.
 */
function validateHistory(history) {
    const badFormat = 'The request was not in the expected format.';

    if (!Array.isArray(history) || history.length % 2 !== 0) {
        return badFormat;
    }
    if (history.length / 2 >= MAX_SEGMENTS) {
        return 'This journey is complete. Please begin a new path.';
    }
    for (let i = 0; i < history.length; i++) {
        const item = history[i];
        const expectedRole = i % 2 === 0 ? 'assistant' : 'user';
        const maxChars = expectedRole === 'assistant' ? MAX_STORY_CHARS : MAX_CHOICE_CHARS;
        const valid = item
            && item.role === expectedRole
            && typeof item.content === 'string'
            && item.content.trim() !== ''
            && item.content.length <= maxChars;
        if (!valid) {
            return badFormat;
        }
    }
    return null;
}

/** Which segment (1-based) a reply to this history will be. */
function segmentNumberFor(history) {
    return history.length / 2 + 1;
}

/**
 * Builds the conversation sent to Claude.
 *
 * Each request must repeat the previous one exactly and only add to the end:
 * prompt caching depends on it. Never rewrite earlier turns.
 *
 * @param {{ role: string, content: string }[]} history
 * @returns {{ role: string, content: string }[]}
 */
function buildMessages(history) {
    const messages = [{ role: 'user', content: 'Begin the journey.' }];
    for (const item of history) {
        messages.push({
            role: item.role,
            content: item.role === 'user' ? `I choose: "${item.content.trim()}"` : item.content
        });
    }
    if (segmentNumberFor(history) >= MAX_SEGMENTS) {
        messages[messages.length - 1].content += FINAL_SEGMENT_NOTE;
    }
    return messages;
}

module.exports = {
    MAX_SEGMENTS,
    MAX_STORY_CHARS,
    MAX_CHOICE_CHARS,
    SYSTEM_PROMPT,
    parseStory,
    validateHistory,
    segmentNumberFor,
    buildMessages
};
