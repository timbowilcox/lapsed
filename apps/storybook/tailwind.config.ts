import type { Config } from "tailwindcss";
import preset from "@lapsed/ui/tailwind-preset";

const config: Config = {
  presets: [preset as Config],
  content: [
    ".storybook/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
};

export default config;
