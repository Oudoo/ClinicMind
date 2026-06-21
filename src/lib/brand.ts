/**
 * Institutional Tech brand bridge.
 *
 * Canonical brand primitives live in globals.css as CSS variables. This module
 * exposes them to TS and, crucially, lets each tenant white-label the accent and
 * product name without a rebuild. `tenantThemeStyle()` returns inline CSS custom
 * properties that override the defaults for that tenant's surface only.
 */

export const BRAND = {
  productName: "ClinicMind",
  tagline: "Integrated Clinical Intelligence, Operating as One.",
  primitives: {
    starkWhite: "#FFFFFF",
    alabaster: "#F8F9FA",
    charcoalSlate: "#1A202C",
    electricIndigo: "#4F46E5",
  },
  fonts: {
    display: "Plus Jakarta Sans",
    mono: "JetBrains Mono",
  },
} as const;

export interface TenantBranding {
  /** Accent hex; defaults to electric indigo. */
  accent?: string;
  /** Replacement product name shown in the embedded surface. */
  productName?: string;
  logoUrl?: string;
}

/**
 * Convert a hex color to the "H S% L%" triplet Tailwind's `hsl(var(--x))`
 * tokens expect. Keeps tenant theming consistent with the rest of the system.
 */
export function hexToHslTriplet(hex: string): string | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1]!, 16) / 255;
  const g = parseInt(m[2]!, 16) / 255;
  const b = parseInt(m[3]!, 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * Inline style object that overrides the accent CSS variables for a tenant.
 * Apply on a wrapping element around the tenant's surface.
 */
export function tenantThemeStyle(branding?: TenantBranding | null): React.CSSProperties {
  const style: Record<string, string> = {};
  if (branding?.accent) {
    const triplet = hexToHslTriplet(branding.accent);
    if (triplet) {
      style["--accent"] = triplet;
      style["--ring"] = triplet;
    }
  }
  return style as React.CSSProperties;
}
