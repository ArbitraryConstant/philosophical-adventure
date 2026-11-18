'use strict';

// Guards against the mistake that once took the site down: a file saved with
// a byte-order mark (BOM), which makes package.json unreadable to Railway.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHECKED_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.md', '.yml', '.svg', '.txt']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

function* projectFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* projectFiles(fullPath);
        } else if (CHECKED_EXTENSIONS.has(path.extname(entry.name))) {
            yield fullPath;
        }
    }
}

test('no project file starts with a BOM', () => {
    for (const file of projectFiles(ROOT)) {
        const bytes = fs.readFileSync(file).subarray(0, 3);
        assert.notDeepEqual([...bytes], [0xef, 0xbb, 0xbf], `${path.relative(ROOT, file)} starts with a BOM`);
    }
});

test('package.json is valid and starts the server', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.start, 'node server.js');
    assert.ok(pkg.engines.node, 'engines.node is set');
    assert.ok(pkg.dependencies.express, 'express is a dependency');
});
