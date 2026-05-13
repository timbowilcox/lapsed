import type { Preview } from "@storybook/react";
import "../src/storybook.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "cream",
      values: [
        { name: "cream", value: "#F8F5EE" },
        { name: "panel", value: "#FCFAF5" },
        { name: "lavender", value: "#B8A6F4" },
        { name: "ink", value: "#0A0A0B" },
      ],
    },
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    layout: "padded",
  },
};

export default preview;
