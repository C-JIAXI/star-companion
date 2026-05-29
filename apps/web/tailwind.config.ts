import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    screens: {
      'xs': '375px',
      'sm': '640px',
      'md': '768px',
      'lg': '1024px',
      'xl': '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        ember: {
          50: "#fdf8f4",
          100: "#faecdf",
          200: "#f5d5b7",
          300: "#f0b887",
          400: "#eb9653",
          500: "#e67a28",
          600: "#d95f1c",
          700: "#b54619",
          800: "#91371b",
          900: "#752e18",
          950: "#3f150a",
        },
        ink: {
          50: "#f5f6f8",
          100: "#e5e7ec",
          200: "#cbd0d9",
          300: "#a6afbf",
          400: "#7a879e",
          500: "#5c6981",
          600: "#485369",
          700: "#3b4355",
          800: "#313847",
          900: "#1a1d28",
          950: "#0c0d12",
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      spacing: {
        'safe-top': 'var(--safe-area-inset-top)',
        'safe-bottom': 'var(--safe-area-inset-bottom)',
        'safe-left': 'var(--safe-area-inset-left)',
        'safe-right': 'var(--safe-area-inset-right)',
      },
      minHeight: {
        'touch': '48px',
      },
      minWidth: {
        'touch': '48px',
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "scale-in": "scaleIn 0.2s ease-out",
        "modal-enter": "modalEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-bottom": "slideInBottom 0.3s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        modalEnter: {
          "0%": { opacity: "0", transform: "scale(0.96) translateY(12px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        slideInBottom: {
          "0%": { opacity: "0", transform: "translateY(100%)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      }
    }
  },
  plugins: []
} satisfies Config;
