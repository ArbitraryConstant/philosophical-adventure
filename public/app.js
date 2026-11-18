/**
 * The Way of Becoming - page script.
 *
 * Asks the server for each part of the story, shows it with its choices,
 * remembers the journey in this browser, and lets the reader save it.
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'wayOfBecoming.journey.v1';
    const RESET_CONFIRM_MS = 4000;

    const el = {
        startScreen: document.getElementById('startScreen'),
        startBtn: document.getElementById('startBtn'),
        continueBtn: document.getElementById('continueBtn'),
        gameContent: document.getElementById('gameContent'),
        progress: document.getElementById('progress'),
        story: document.getElementById('storyContainer'),
        choices: document.getElementById('choicesContainer'),
        savePanel: document.getElementById('savePanel'),
        saveToggle: document.getElementById('saveToggle'),
        saveOptions: document.getElementById('saveOptions'),
        resetBtn: document.getElementById('resetBtn'),
        pathContainer: document.getElementById('pathContainer'),
        pathList: document.getElementById('pathList')
    };

    const state = {
        /** The journey as the server expects it: story, choice, story, choice, ... */
        history: [],
        /** What the reader has seen, for saving: { story, concept, chosen }. */
        segments: [],
        /** The server's latest reply, i.e. what is on screen now. */
        current: null,
        /** Increases on every reset so a reply to an abandoned journey is ignored. */
        journeyId: 0
    };

    let resetConfirmTimer = null;

    // ---- Remembering the journey in this browser --------------------------

    function saveProgress() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                history: state.history,
                segments: state.segments,
                current: state.current
            }));
        } catch {
            // Storage can be full or disabled; the game still works without it.
        }
    }

    function clearProgress() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // Nothing to clear.
        }
    }

    /** Returns a previously saved journey, or null if there is none worth resuming. */
    function loadProgress() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            const usable = saved
                && Array.isArray(saved.history)
                && Array.isArray(saved.segments)
                && saved.segments.length > 0
                && saved.current
                && typeof saved.current.story === 'string';
            return usable ? saved : null;
        } catch {
            return null;
        }
    }

    // ---- Talking to the server --------------------------------------------

    /** Parses JSON, returning null instead of throwing if the text is not JSON. */
    function parseJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    /** Asks the server for the next story segment. `choice` is null for the opening. */
    async function requestStory(choice) {
        const thisJourney = state.journeyId;

        showLoading();

        try {
            const response = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    history: choice === null
                        ? state.history
                        : [...state.history, { role: 'user', content: choice }]
                })
            });

            // Read as text first: if the server sends back something that
            // isn't JSON (an error page, an empty reply), don't crash on it.
            const data = parseJson(await response.text());

            if (thisJourney !== state.journeyId) return;

            if (!response.ok || !data) {
                const serverMessage = data && typeof data.error === 'string' ? data.error : '';
                throw new Error(serverMessage || `The story server is not responding correctly (status ${response.status}).`);
            }
            if (typeof data.story !== 'string' || !data.story.trim()) {
                throw new Error('The server returned an empty story.');
            }

            // Only record the turn once it has succeeded, so a failed
            // request can be retried without corrupting the journey.
            if (choice !== null) {
                state.history.push({ role: 'user', content: choice });
                state.segments[state.segments.length - 1].chosen = choice;
            }
            state.history.push({ role: 'assistant', content: typeof data.raw === 'string' ? data.raw : data.story });
            state.segments.push({
                story: data.story.trim(),
                concept: typeof data.concept === 'string' ? data.concept.trim() : '',
                chosen: ''
            });
            state.current = {
                story: data.story,
                concept: data.concept,
                choices: data.choices,
                segment: data.segment,
                totalSegments: data.totalSegments,
                final: Boolean(data.final)
            };

            saveProgress();
            showStory(state.current);
            showPath();
        } catch (error) {
            if (thisJourney !== state.journeyId) return;
            console.error('Could not load the story:', error);
            const offline = error instanceof TypeError;
            showError(
                offline ? 'Could not reach the story server. Please check your connection.' : (error.message || 'Unknown error'),
                () => requestStory(choice)
            );
        }
    }

    // ---- Showing things ----------------------------------------------------

    function showLoading() {
        const loading = document.createElement('div');
        loading.className = 'loading';
        loading.setAttribute('role', 'status');
        loading.textContent = 'Contemplating the Way...';
        el.story.replaceChildren(loading);
        el.choices.replaceChildren();
    }

    function choicesOf(data) {
        return Array.isArray(data.choices)
            ? data.choices.filter(choice => typeof choice === 'string' && choice.trim())
            : [];
    }

    function showStory(data) {
        const choices = choicesOf(data);

        if (Number.isInteger(data.segment) && Number.isInteger(data.totalSegments)) {
            el.progress.textContent = `Part ${data.segment} of ${data.totalSegments}`;
            el.progress.hidden = false;
        } else {
            el.progress.hidden = true;
        }

        // textContent (never innerHTML) so the story cannot inject markup.
        const storyText = document.createElement('div');
        storyText.className = 'story-text';
        for (const paragraph of paragraphsOf(data.story)) {
            const p = document.createElement('p');
            p.textContent = paragraph;
            storyText.appendChild(p);
        }
        el.story.replaceChildren(storyText);

        if (typeof data.concept === 'string' && data.concept.trim()) {
            const badge = document.createElement('div');
            badge.className = 'concept-badge';
            badge.textContent = data.concept.trim();
            el.story.appendChild(badge);
        }

        el.choices.replaceChildren(...choices.map(choice => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'choice-btn';
            button.textContent = choice;
            button.addEventListener('click', () => makeChoice(choice));
            return button;
        }));

        el.savePanel.hidden = false;
        el.resetBtn.hidden = false;
        disarmReset();
        scrollToStory();
    }

    function showError(message, retry) {
        const errorBox = document.createElement('div');
        errorBox.className = 'error';
        errorBox.setAttribute('role', 'alert');
        const label = document.createElement('strong');
        label.textContent = 'An error occurred: ';
        errorBox.append(label, message);
        el.story.replaceChildren(errorBox);

        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'choice-btn';
        retryButton.textContent = 'Try again';
        retryButton.addEventListener('click', retry);
        el.choices.replaceChildren(retryButton);

        el.resetBtn.hidden = false;
    }

    function showPath() {
        const chosen = state.segments.map(segment => segment.chosen).filter(Boolean);
        el.pathContainer.hidden = chosen.length === 0;
        el.pathList.replaceChildren(...chosen.map((choice, index) => {
            const item = document.createElement('div');
            item.className = 'path-item';
            item.textContent = `Step ${index + 1}: ${choice}`;
            return item;
        }));
    }

    /** Brings the top of the story into view if the reader has scrolled past it. */
    function scrollToStory() {
        const card = el.gameContent.closest('.game-card');
        if (card.getBoundingClientRect().top >= 0) return;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }

    function showStartScreen() {
        const hasSaved = loadProgress() !== null;
        el.continueBtn.hidden = !hasSaved;
        el.startBtn.textContent = hasSaved ? 'Begin a New Journey' : 'Begin Your Journey';
        el.startScreen.hidden = false;
        el.gameContent.hidden = true;
    }

    function showGameScreen() {
        el.startScreen.hidden = true;
        el.gameContent.hidden = false;
        el.progress.hidden = true;
        el.resetBtn.hidden = true;
        el.pathContainer.hidden = true;
        hideSavePanel();
    }

    // ---- Playing -----------------------------------------------------------

    function startJourney() {
        state.journeyId++;
        state.history = [];
        state.segments = [];
        state.current = null;
        clearProgress();

        showGameScreen();
        requestStory(null);
    }

    function continueJourney() {
        const saved = loadProgress();
        if (!saved) {
            startJourney();
            return;
        }
        state.journeyId++;
        state.history = saved.history;
        state.segments = saved.segments;
        state.current = saved.current;

        showGameScreen();
        showStory(state.current);
        showPath();
    }

    function makeChoice(choice) {
        for (const button of el.choices.querySelectorAll('button')) {
            button.disabled = true;
        }
        requestStory(choice);
    }

    /**
     * "Begin a New Path". Partway through a journey this asks for a second
     * click first, because it discards the story so far.
     */
    function onResetClick() {
        const midJourney = state.segments.length > 0 && !(state.current && state.current.final);
        const armed = el.resetBtn.dataset.armed === 'true';

        if (midJourney && !armed) {
            el.resetBtn.dataset.armed = 'true';
            el.resetBtn.textContent = 'Leave this journey? Click again to confirm';
            resetConfirmTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
            return;
        }

        disarmReset();
        state.journeyId++;
        state.history = [];
        state.segments = [];
        state.current = null;
        clearProgress();

        el.story.replaceChildren();
        el.choices.replaceChildren();
        el.pathList.replaceChildren();
        showStartScreen();
    }

    function disarmReset() {
        clearTimeout(resetConfirmTimer);
        delete el.resetBtn.dataset.armed;
        el.resetBtn.textContent = 'Begin a New Path';
    }

    // ---- Saving the story --------------------------------------------------

    function hideSavePanel() {
        el.savePanel.hidden = true;
        el.saveOptions.hidden = true;
        el.saveToggle.setAttribute('aria-expanded', 'false');
    }

    function toggleSaveOptions() {
        el.saveOptions.hidden = !el.saveOptions.hidden;
        el.saveToggle.setAttribute('aria-expanded', String(!el.saveOptions.hidden));
    }

    function paragraphsOf(story) {
        return story.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
    }

    function savedOnLine() {
        const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        return `Saved on ${date}`;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function storyAsText() {
        const lines = ['THE WAY OF BECOMING', 'A Philosophical Journey', savedOnLine(), ''];
        state.segments.forEach((segment, index) => {
            lines.push('----------------------------------------', '');
            lines.push(`Part ${index + 1}${segment.concept ? ` - ${segment.concept}` : ''}`, '');
            for (const paragraph of paragraphsOf(segment.story)) lines.push(paragraph, '');
            if (segment.chosen) lines.push(`You chose: ${segment.chosen}`, '');
        });
        return lines.join('\r\n');
    }

    function storyAsMarkdown() {
        const lines = ['# The Way of Becoming', '', `*A Philosophical Journey - ${savedOnLine()}*`, ''];
        state.segments.forEach((segment, index) => {
            lines.push(`## Part ${index + 1}${segment.concept ? `: ${segment.concept}` : ''}`, '');
            for (const paragraph of paragraphsOf(segment.story)) lines.push(paragraph, '');
            if (segment.chosen) lines.push(`> **You chose:** ${segment.chosen}`, '');
        });
        return lines.join('\n');
    }

    function storyAsHtml() {
        const parts = state.segments.map((segment, index) => {
            const heading = `Part ${index + 1}${segment.concept ? `: ${escapeHtml(segment.concept)}` : ''}`;
            const body = paragraphsOf(segment.story).map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('\n');
            const chosen = segment.chosen ? `<p class="chosen">You chose: ${escapeHtml(segment.chosen)}</p>` : '';
            return `<section>\n<h2>${heading}</h2>\n${body}\n${chosen}\n</section>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Way of Becoming - My Journey</title>
<style>
body { font-family: Georgia, "Times New Roman", serif; color: #1a1510; background: #f5f1e8; max-width: 42rem; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.8; font-size: 1.1rem; }
h1 { color: #8b4513; font-weight: normal; font-size: 2.4rem; text-align: center; margin-bottom: 0.25rem; }
.meta { text-align: center; color: #7a6a4f; font-size: 0.9rem; margin-bottom: 3rem; }
h2 { color: #8b4513; font-weight: normal; font-size: 1rem; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 3rem; border-top: 1px solid #c9b896; padding-top: 1.5rem; }
.chosen { color: #8b4513; font-style: italic; border-left: 2px solid #c9b896; padding-left: 1rem; }
@media print { body { background: #fff; padding: 0; } h2 { break-after: avoid; } }
</style>
</head>
<body>
<h1>The Way of Becoming</h1>
<p class="meta">A Philosophical Journey &middot; ${escapeHtml(savedOnLine())}</p>
${parts}
</body>
</html>
`;
    }

    function downloadFile(filename, mimeType, content) {
        const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Opens the browser's print window for the story; "Save as PDF" is offered there. */
    function printStory() {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;';
        frame.addEventListener('load', () => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            setTimeout(() => frame.remove(), 60000);
        });
        frame.srcdoc = storyAsHtml();
        document.body.appendChild(frame);
    }

    function saveStory(format) {
        if (state.segments.length === 0) return;

        const now = new Date();
        const stamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('-');
        const name = `the-way-of-becoming-${stamp}`;

        if (format === 'txt') downloadFile(`${name}.txt`, 'text/plain', storyAsText());
        else if (format === 'md') downloadFile(`${name}.md`, 'text/markdown', storyAsMarkdown());
        else if (format === 'html') downloadFile(`${name}.html`, 'text/html', storyAsHtml());
        else if (format === 'print') printStory();
    }

    // ---- Wiring ------------------------------------------------------------

    el.startBtn.addEventListener('click', startJourney);
    el.continueBtn.addEventListener('click', continueJourney);
    el.resetBtn.addEventListener('click', onResetClick);
    el.saveToggle.addEventListener('click', toggleSaveOptions);
    el.saveOptions.addEventListener('click', event => {
        const button = event.target.closest('[data-save-format]');
        if (button) saveStory(button.dataset.saveFormat);
    });

    showStartScreen();
})();
