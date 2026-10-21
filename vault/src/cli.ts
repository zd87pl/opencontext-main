#!/usr/bin/env node
import { processIo } from './cli/io.js';
import { runCli } from './cli/run.js';

// The bin entry: everything lives in runCli so tests can run the same code in-process.
process.exitCode = await runCli(process.argv.slice(2), processIo());
