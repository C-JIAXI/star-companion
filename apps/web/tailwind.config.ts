import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
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
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "scale-in": "scaleIn 0.2s ease-out",
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
        }
      }
    }
  },
  plugins: []
} satisfies Config;
