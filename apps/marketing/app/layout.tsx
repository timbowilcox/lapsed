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
  title: "lapsed. — Recover the customers you already paid for",
  description:
    "lapsed.ai identifies dormant Shopify customers, scores reactivation likelihood, and wins them back with two-way AI SMS conversations.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    url: "https://lapsed.ai",
    title: "lapsed. — Recover the customers you already paid for",
    description:
      "lapsed.ai identifies dormant Shopify customers, scores reactivation likelihood, and wins them back with two-way AI SMS conversations.",
    siteName: "lapsed.",
    images: [{ url: "https://lapsed.ai/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "lapsed. — Recover the customers you already paid for",
    description:
      "lapsed.ai identifies dormant Shopify customers, scores reactivation likelihood, and wins them back with two-way AI SMS conversations.",
    images: ["https://lapsed.ai/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans bg-cream-100 text-ink-900">{children}</body>
    </html>
  );
}
