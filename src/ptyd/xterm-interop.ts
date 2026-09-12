/**
 * `@xterm/headless` and `@xterm/addon-serialize` ship CommonJS bundles whose
 * named exports Node's ESM loader cannot see, so importing `{ Terminal }`
 * directly throws at runtime. Their type declarations do describe named
 * exports, which lets us keep full typing while going through the default
 * import at runtime. This shim is the only place that knows about it.
 */

import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import type { Terminal as TerminalClass } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonClass } from '@xterm/addon-serialize';

export const Terminal = (headlessPkg as unknown as { Terminal: typeof TerminalClass })
  .Terminal;

export const SerializeAddon = (
  serializePkg as unknown as { SerializeAddon: typeof SerializeAddonClass }
).SerializeAddon;

export type HeadlessTerminal = TerminalClass;
export type Serializer = SerializeAddonClass;
