/**
 * The browser tab icon, drawn from the same mark as the app icon.
 *
 * Static by default: an icon that changes colour on its own is distracting in a
 * row of pinned tabs, and the connection state is already reported by the
 * status pill in the corner. Turning on "Animate the tab icon" makes it report
 * health instead — amber while reconnecting, red when ptyd is unreachable, with
 * a dot when a background session produced output you have not seen.
 */

export type FaviconState = 'ok' | 'warn' | 'down';

const STATE_COLORS: Record<FaviconState, string> = {
  ok: '#7aa2ff',
  warn: '#f0c274',
  down: '#ff6b81',
};

function svg(state: FaviconState, badge: boolean): string {
  const accent = STATE_COLORS[state];
  const badgeMark = badge
    ? `<circle cx="25.5" cy="6.5" r="5.5" fill="#ff9d3d" stroke="#12151d" stroke-width="2"/>`
    : '';
  // Deliberately chunky: at 16 px only the chevron and the cursor survive, so
  // they carry the whole identity and the decorative nodes are left out.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#12151d"/>
<path d="M9.5 10.5 L15 16 L9.5 21.5" fill="none" stroke="${accent}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="17" y="18.6" width="8.5" height="3.2" rx="1.6" fill="#e6eaf2"/>
${badgeMark}
</svg>`;
}

let lastKey = '';

export function updateFavicon(
  state: FaviconState,
  badge: boolean,
  animate: boolean,
): void {
  // When the icon is static we still install it once, so the tab shows the
  // crisp inline mark rather than waiting on the file request.
  const effectiveState = animate ? state : 'ok';
  const effectiveBadge = animate && badge;

  const key = `${effectiveState}:${effectiveBadge}`;
  if (key === lastKey) return;
  lastKey = key;

  let link = document.querySelector<HTMLLinkElement>('link#dynamic-favicon');
  if (!link) {
    link = document.createElement('link');
    link.id = 'dynamic-favicon';
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(
    svg(effectiveState, effectiveBadge),
  )}`;
}
