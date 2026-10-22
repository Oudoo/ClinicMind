/** Tailwind build for the static click-through prototype. Mirrors the app's tokens (tailwind.config.ts). */
module.exports = {
  darkMode: ["class"],
  content: ["./demo/index.html", "./demo/assets/*.js"],
  theme: {
    extend: {
      colors: {
        "stark-white": "#FFFFFF",
        alabaster: "#F8F9FA",
        "charcoal-slate": "#1A202C",
        "electric-indigo": "#4F46E5",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        muted: { DEFAULT: "hsl(var(--muted) / <alpha-value>)", foreground: "hsl(var(--muted-foreground) / <alpha-value>)" },
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)", foreground: "hsl(var(--card-foreground) / <alpha-value>)" },
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
        sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        display: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: { lg: "0.5rem", md: "0.375rem", sm: "0.25rem" },
      letterSpacing: { tightest: "-0.04em" },
      backdropBlur: { glass: "12px" },
      backgroundImage: {
        "mesh-grid":
          "linear-gradient(hsl(var(--border)/0.6) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.6) 1px, transparent 1px)",
      },
      backgroundSize: { mesh: "24px 24px" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, calc(-50% + 6px))" },
          to: { opacity: "1", transform: "translate(-50%, -50%)" },
        },
      },
      animation: { "fade-in": "fade-in 0.25s ease-out", "dialog-in": "dialog-in 0.25s ease-out" },
    },
  },
  plugins: [],
};
