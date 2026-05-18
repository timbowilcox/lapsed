import { Geist, Instrument_Serif } from "next/font/google";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "lapsed.",
  description: "Recover the customers you already paid for.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    // apple-touch-icon.png to be added when design assets are finalised
  },
};

// NEXT_PUBLIC_SHOPIFY_API_KEY is the same value as SHOPIFY_API_KEY but
// exposed to the client bundle (Next inlines `process.env.NEXT_PUBLIC_*`
// at build time). Required by App Bridge so the bootstrap script can
// read the api key from a meta tag in <head>.
const SHOPIFY_API_KEY = process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? "";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <head>
        {/*
          Shopify App Bridge must be the FIRST <script> in the document
          head, loaded from Shopify's CDN, with no async / defer /
          type=module. The library aborts loudly if any of those
          conditions are violated. Placing the meta tag immediately
          before lets App Bridge read the app's api key.

          The Next.js <Script> component cannot be used here — it
          injects async automatically. A literal <script> JSX element
          inside <head> (as opposed to inside <body>) bypasses React 19's
          Document-Metadata script hoisting which is what was forcing
          async earlier.
        */}
        <meta name="shopify-api-key" content={SHOPIFY_API_KEY} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      </head>
      <body className="font-sans bg-cream-100 text-ink-900">{children}</body>
    </html>
  );
}
