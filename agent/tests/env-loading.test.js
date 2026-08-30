'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

describe('env loading', () => {
  test('the repo-root .env is loaded, not only agent/.env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(
      src,
      /dotenv\.config\(\{\s*path:\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'\.env'\)/,
      'server.js must load the repo-root .env so shared credentials reach the agent'
    );
  });
});
