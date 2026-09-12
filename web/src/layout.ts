/**
 * Split-pane layout.
 *
 * A binary tree of panes. Tabs address sessions; panes are viewports onto them.
 * A session lives in at most one pane, because a terminal has exactly one DOM
 * node and moving it is cheaper and less surprising than duplicating it.
 */

export interface LeafNode {
  kind: 'leaf';
  id: string;
  sessionId: string | null;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: 'row' | 'column';
  /** Fraction of the axis taken by the first child, 0.1–0.9. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function makeLeaf(sessionId: string | null = null): LeafNode {
  return { kind: 'leaf', id: nextId('pane'), sessionId };
}

export function findLeaf(node: LayoutNode, paneId: string): LeafNode | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null;
  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId);
}

export function leaves(node: LayoutNode): LeafNode[] {
  return node.kind === 'leaf' ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

function mapNode(
  node: LayoutNode,
  fn: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return fn(node);
  return { ...node, first: mapNode(node.first, fn), second: mapNode(node.second, fn) };
}

/**
 * Split the given pane, putting a fresh pane beside it.
 *
 * `before` places the new pane first, which is what a drop on the left or top
 * edge means: the terminal should land where the pointer was, not on the
 * opposite side.
 */
export function splitPane(
  root: LayoutNode,
  paneId: string,
  direction: 'row' | 'column',
  options: { before?: boolean; sessionId?: string | null } = {},
): { root: LayoutNode; newPaneId: string } {
  const fresh = makeLeaf(options.sessionId ?? null);
  const next = mapNode(root, (leaf) =>
    leaf.id === paneId
      ? {
          kind: 'split',
          id: nextId('split'),
          direction,
          ratio: 0.5,
          first: options.before ? fresh : leaf,
          second: options.before ? leaf : fresh,
        }
      : leaf,
  );
  return { root: next, newPaneId: fresh.id };
}

/** Remove a pane, collapsing its parent split. Never removes the last pane. */
export function closePane(root: LayoutNode, paneId: string): LayoutNode {
  if (root.kind === 'leaf') return root;

  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'leaf') return node.id === paneId ? null : node;
    const first = prune(node.first);
    const second = prune(node.second);
    if (first === null) return second;
    if (second === null) return first;
    return { ...node, first, second };
  };

  return prune(root) ?? makeLeaf(null);
}

export function setPaneSession(
  root: LayoutNode,
  paneId: string,
  sessionId: string | null,
): LayoutNode {
  return mapNode(root, (leaf) => {
    // A session shows in one place at a time: clear it wherever it was before.
    if (leaf.id !== paneId) {
      return leaf.sessionId === sessionId ? { ...leaf, sessionId: null } : leaf;
    }
    return { ...leaf, sessionId };
  });
}

export function setRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId) {
      return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  return walk(root);
}

/**
 * Rehome panes whose session has gone away.
 *
 * Closing a terminal should reveal the next one, the way closing a browser tab
 * does — not leave a hole where it used to be. Panes are only emptied when
 * there is genuinely nothing left to show, and never closed automatically: the
 * split is the user's, and they have a button for it.
 */
export function pruneMissingSessions(
  root: LayoutNode,
  existing: ReadonlySet<string>,
  preferred: readonly string[] = [],
): LayoutNode {
  const stale = leaves(root).filter(
    (leaf) => leaf.sessionId !== null && !existing.has(leaf.sessionId),
  );
  if (stale.length === 0) return root;

  const shown = new Set(
    leaves(root)
      .map((leaf) => leaf.sessionId)
      .filter((id): id is string => id !== null && existing.has(id)),
  );
  const spare = [
    ...preferred.filter((id) => existing.has(id) && !shown.has(id)),
    ...[...existing].filter((id) => !shown.has(id) && !preferred.includes(id)),
  ];

  let next = root;
  for (const leaf of stale) {
    next = setPaneSession(next, leaf.id, spare.shift() ?? null);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function serializeLayout(root: LayoutNode): unknown {
  return root;
}

/** Rebuild from stored JSON, regenerating ids so they cannot collide. */
export function deserializeLayout(value: unknown): LayoutNode | null {
  const walk = (node: any): LayoutNode | null => {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'leaf') {
      return {
        kind: 'leaf',
        id: nextId('pane'),
        sessionId: typeof node.sessionId === 'string' ? node.sessionId : null,
      };
    }
    if (node.kind === 'split') {
      const first = walk(node.first);
      const second = walk(node.second);
      if (!first || !second) return null;
      return {
        kind: 'split',
        id: nextId('split'),
        direction: node.direction === 'column' ? 'column' : 'row',
        ratio: typeof node.ratio === 'number' ? Math.min(0.9, Math.max(0.1, node.ratio)) : 0.5,
        first,
        second,
      };
    }
    return null;
  };
  return walk(value);
}
