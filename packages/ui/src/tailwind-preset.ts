import type { Config } from "tailwindcss";

const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        lavender: {
          50: "#F5F1FF",
          100: "#E8DFFC",
          200: "#D4C5F8",
          400: "#B8A6F4",
          500: "#9C85EE",
          700: "#6B52C9",
        },
        cream: {
          50: "#FCFAF5",
          100: "#F8F5EE",
          200: "#F2EDE2",
          300: "#E8E1D2",
          400: "#D6CCB7",
        },
        ink: {
          900: "#0A0A0B",
          700: "#2E2C2A",
          600: "#48453F",
          500: "#5F5C57",
          400: "#79766F",
          300: "#94918A",
        },
        success: {
          500: "#2D8A4E",
          100: "#DDF0E2",
        },
        warning: {
          500: "#C8941E",
          100: "#F8ECCD",
        },
        danger: {
          // 700 is the AA-contrast text shade — small (12px) danger text on a
          // cream surface needs ≥ 4.5:1, which danger-500 does not clear.
          700: "#9A2F2F",
          500: "#C04848",
          100: "#F4DCDC",
        },
        border: "#ECE6D6",
        "border-strong": "#D8D0BC",
      },
      fontFamily: {
        sans: ['"Geist"', "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        serif: ['"Instrument Serif"', "Georgia", "serif"],
      },
      fontSize: {
        hero: ["64px", { lineHeight: "1.0", letterSpacing: "-0.03em", fontWeight: "400" }],
        display: ["28px", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "500" }],
        h1: ["22px", { lineHeight: "1.2", letterSpacing: "-0.015em", fontWeight: "600" }],
        h2: ["18px", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "600" }],
        h3: ["15px", { lineHeight: "1.35", letterSpacing: "0", fontWeight: "600" }],
        body: ["14px", { lineHeight: "1.5", letterSpacing: "0", fontWeight: "400" }],
        "body-strong": ["14px", { lineHeight: "1.5", letterSpacing: "0", fontWeight: "500" }],
        meta: ["13px", { lineHeight: "1.4", letterSpacing: "0", fontWeight: "400" }],
        label: ["13px", { lineHeight: "1.3", letterSpacing: "0", fontWeight: "500" }],
        mini: ["12px", { lineHeight: "1.35", letterSpacing: "0", fontWeight: "500" }],
        micro: ["11px", { lineHeight: "1.4", letterSpacing: "0.04em", fontWeight: "600" }],
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "20px",
        pill: "999px",
      },
      spacing: {
        "0": "0",
        "2": "2px",
        "4": "4px",
        "6": "6px",
        "8": "8px",
        "10": "10px",
        "12": "12px",
        "14": "14px",
        "16": "16px",
        "20": "20px",
        "24": "24px",
        "28": "28px",
        "32": "32px",
        "40": "40px",
        "44": "44px",
        "48": "48px",
        "64": "64px",
      },
      boxShadow: {
        focus: "0 0 0 2px #FCFAF5, 0 0 0 4px #6B52C9",
      },
      animation: {
        pulse: "lapsed-pulse 2s infinite",
        reveal: "lapsed-reveal 400ms ease-out both",
      },
      keyframes: {
        "lapsed-pulse": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.3" },
          "50%": { transform: "scale(1.6)", opacity: "0" },
        },
        "lapsed-reveal": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
};

export default preset;
