/**
 * Mint a one-shot pairing key and print it as JSON.
 *
 * This is what `ptyhub link` does; it exists as a standalone script so the
 * smoke test can create a pairing inside its sandbox rather than against the
 * real state directory.
 */

import { Auth } from '../src/web/auth.ts';

const user = process.argv[2] ?? 'ptyhub';
process.stdout.write(JSON.stringify(Auth.createPairing(user)));
