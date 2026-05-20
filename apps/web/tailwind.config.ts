import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ember: {
          400: "#f0a35e",
          500: "#d9823b"
        },
        ink: {
          950: "#0c0d12",
          900: "#12141c",
          800: "#1a1d28",
          700: "#242938"
        }
      }
    }
  },
  plugins: []
} satisfies Config;
