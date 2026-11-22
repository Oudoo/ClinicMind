import type { Config } from "tailwindcss";

/**
 * ClinicMind design tokens (DESIGN.md describes how they are used).
 *
 * Every colour is a CSS variable (src/app/globals.css), so each tenant can override the
 * accent at runtime (white-labeling) without a rebuild: see src/lib/brand.ts.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Brand primitives: graphite and prescription ink.
        "stark-white": "#FFFFFF",
        alabaster: "#FAFAFA",
        "charcoal-slate": "#171717",
        ink: "#1D4B9A",
        // Semantic tokens driven by CSS variables (theme + tenant override aware)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        // The navigation rail's ground.
        sidebar: "hsl(var(--sidebar) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
          muted: "hsl(var(--accent-muted) / <alpha-value>)",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        // IBM Plex for the interface, with its Arabic sibling behind it so a patient's name in
        // Arabic is drawn in the same family; Plex Mono only for codes and reference numbers.
        sans: ["var(--font-plex)", "var(--font-plex-arabic)", "IBM Plex Sans", "system-ui", "sans-serif"],
        display: ["var(--font-plex)", "var(--font-plex-arabic)", "IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        xl: "0.75rem", // 12px: cards and panels
        lg: "0.5rem", // 8px: buttons, fields, rows
        md: "0.375rem", // 6px: chips and menu items
        sm: "0.25rem",
      },
      transitionTimingFunction: {
        // One curve for every transition.
        DEFAULT: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      backgroundImage: {
        "mesh-grid":
          "linear-gradient(hsl(var(--border)/0.6) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.6) 1px, transparent 1px)",
      },
      backgroundSize: {
        mesh: "24px 24px",
      },
      keyframes: {
        // Opacity only: a transform in the keyframes would override the
        // translate utilities of centred elements while it runs.
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // Centred dialogs: keeps the -50%/-50% translate throughout.
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, calc(-50% + 6px))" },
          to: { opacity: "1", transform: "translate(-50%, -50%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
        "dialog-in": "dialog-in 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
