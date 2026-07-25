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
          50: "#effcf9",
          100: "#d5f7ef",
          200: "#aeeedf",
          300: "#78dec9",
          400: "#45cbb2",
          500: "#27b69d",
          600: "#1a917e",
          700: "#197465",
          800: "#195d53",
          900: "#174d45",
          950: "#082d29",
        },
        ink: {
          50: "#f4f6f5",
          100: "#e2e7e5",
          200: "#c6cecb",
          300: "#a2aeaa",
          400: "#788783",
          500: "#5c6966",
          600: "#454f4d",
          700: "#303937",
          800: "#1b2221",
          900: "#121716",
          950: "#0a0e0d",
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn 0.16s ease-out",
        "scale-in": "scaleIn 0.16s ease-out",
        "modal-enter": "modalEnter 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        modalEnter: {
          "0%": { opacity: "0", transform: "scale(0.98) translateY(8px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
      }
    }
  },
  plugins: []
} satisfies Config;
