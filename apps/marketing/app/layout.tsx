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
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans bg-cream-100 text-ink-900">{children}</body>
    </html>
  );
}
