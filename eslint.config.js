'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/'] },
    js.configs.recommended,
    {
        rules: {
            'eqeqeq': 'error',
            'no-var': 'error',
            'prefer-const': 'error'
        }
    },
    {
        // Server code and tests
        files: ['**/*.js'],
        ignores: ['public/**'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: globals.node
        }
    },
    {
        // The page script
        files: ['public/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: globals.browser
        }
    }
];
