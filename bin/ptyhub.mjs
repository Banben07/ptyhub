#!/usr/bin/env node
/**
 * Entry point for the `ptyhub` command.
 *
 * Registers the TypeScript loader in this process rather than re-execing a
 * child, so `attach` gets the real terminal on stdin and Ctrl+C lands where it
 * should.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(root, 'src', 'cli', 'index.ts')).href);
