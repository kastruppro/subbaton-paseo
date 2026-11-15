/** WCAG 2.x contrast ratio of two #rrggbb colours (used to guard the footer and popover text). */
const channel = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
function luminance(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Background of the hovered footer: the usual raised surface (surface2) unless the footer's text colours
 * (foreground, amber and red) fall below WCAG AA (4.5:1) on it in this theme; then the lighter surface1.
 */
export function footerHoverSurface(c: {
  surface1: string;
  surface2: string;
  foreground: string;
  statusWarning: string;
  statusDanger: string;
}): string {
  const ok = (surface: string) =>
    [c.foreground, c.statusWarning, c.statusDanger].every((token) => contrastRatio(token, surface) >= 4.5);
  return ok(c.surface2) ? c.surface2 : c.surface1;
}
