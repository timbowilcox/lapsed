import { Geist, Instrument_Serif } from "next/font/google";
import Script from "next/script";
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
  other: {
    "shopify-api-key": process.env.SHOPIFY_API_KEY ?? "",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // App Bridge expects a sync script tag. React 19 / Next.js add async
  // automatically — Shopify's runtime emits a console warning about
  // this, but the bridge still initialises correctly inside the
  // Shopify Admin iframe. We use Next's <Script> with
  // strategy="beforeInteractive" to load it as early as possible.
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans bg-cream-100 text-ink-900">
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
