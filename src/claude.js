'use strict';

/**
 * The call to the Claude API.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const API_TIMEOUT_MS = 120000;

// Current models think before answering, and that thinking counts against
// this limit, so it needs room beyond the story itself.
const MAX_OUTPUT_TOKENS = 16000;

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

/** A failure with a status code and a message that is safe to show a reader. */
class ClaudeError extends Error {
    /**
     * @param {number} status HTTP status to answer the browser with.
     * @param {string} message Shown to the reader.
     * @param {string} [detail] Written to the server log only.
     */
    constructor(status, message, detail) {
        super(message);
        this.name = 'ClaudeError';
        this.status = status;
        this.detail = detail;
    }
}

/** Parses JSON, returning null instead of throwing if the text is not JSON. */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Asks Claude for the next part of a conversation.
 *
 * @param {{ system: string, messages: { role: string, content: string }[] }} request
 * @returns {Promise<{ text: string, usage: object }>} The reply's text and token usage.
 * @throws {ClaudeError}
 */
async function askClaude({ system, messages }) {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new ClaudeError(500, 'The story server is not configured (missing API key).', 'ANTHROPIC_API_KEY is not set');
    }

    let response;
    let rawBody;
    try {
        response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': API_VERSION
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: MAX_OUTPUT_TOKENS,
                // Prompt caching: the story so far is re-sent on every turn, and
                // this lets Claude re-read it at a fraction of the normal price.
                cache_control: { type: 'ephemeral' },
                system,
                messages
            }),
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        // Read the body as text first so a non-JSON reply can't crash us.
        rawBody = await response.text();
    } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            throw new ClaudeError(504, 'Claude took too long to respond. Please try again.', `Timed out after ${API_TIMEOUT_MS} ms`);
        }
        throw new ClaudeError(502, 'Could not reach Claude. Please try again.', String(error));
    }

    const data = parseJson(rawBody);

    if (!response.ok || !data || data.type === 'error' || data.error) {
        throw new ClaudeError(
            response.ok ? 502 : response.status,
            data?.error?.message || `Claude API request failed (status ${response.status})`,
            `API error (status ${response.status}): ${rawBody.slice(0, 2000)}`
        );
    }

    if (data.stop_reason === 'refusal') {
        throw new ClaudeError(
            502,
            'Claude declined to continue this story. Please try again.',
            `Refusal: ${JSON.stringify(data.stop_details || {})}`
        );
    }

    // The reply is a list of blocks (thinking, text, ...). Join the text ones.
    const text = (Array.isArray(data.content) ? data.content : [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
        .trim();

    if (!text) {
        throw new ClaudeError(
            502,
            'Claude returned an empty reply. Please try again.',
            `No text in response (stop_reason ${data.stop_reason}): ${JSON.stringify(data).slice(0, 2000)}`
        );
    }

    if (data.stop_reason === 'max_tokens') {
        console.warn('Claude response was cut off at max_tokens');
    }

    return { text, usage: data.usage || {} };
}

module.exports = { MODEL, ClaudeError, askClaude };
