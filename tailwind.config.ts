import type { Config } from "tailwindcss";

/**
 * ClinicMind — Institutional Tech design system.
 *
 * Palette, type scale and spacing are derived from the GROW "Institutional Tech"
 * brand (Stripe x McKinsey). All colors are exposed as CSS variables so that each
 * tenant can override the accent at runtime (white-labeling) without a rebuild.
 * See src/lib/brand.ts for the per-tenant theming bridge.
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
        // Brand primitives (institutional tech)
        "stark-white": "#FFFFFF",
        alabaster: "#F8F9FA",
        "charcoal-slate": "#1A202C",
        "electric-indigo": "#4F46E5",
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
        // Headers: institutional grotesque. Body: clean sans. Data: monospace.
        sans: ["var(--font-jakarta)", "Plus Jakarta Sans", "system-ui", "sans-serif"],
        display: ["var(--font-jakarta)", "Plus Jakarta Sans", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "0.5rem", // 8px — brand radius
        md: "0.375rem",
        sm: "0.25rem",
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      backdropBlur: {
        glass: "12px", // brand glassmorphism
      },
      backgroundImage: {
        "indigo-flow": "linear-gradient(135deg, #4F46E5 0%, #6366F1 50%, #818CF8 100%)",
        "mesh-grid":
          "linear-gradient(hsl(var(--border)/0.6) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.6) 1px, transparent 1px)",
      },
      backgroundSize: {
        mesh: "24px 24px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-spike": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "pulse-spike": "pulse-spike 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
