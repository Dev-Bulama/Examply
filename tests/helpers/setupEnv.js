'use strict';

// Runs before each test file: test env + an isolated storage directory per file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseTestEnv } = require('./testEnv');

Object.assign(process.env, baseTestEnv());
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-test-'));
