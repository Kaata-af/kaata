import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kaata — Run your shop on trust.",
  description:
    "Kaata is a digital ledger for shopkeepers. Replace the paper notebook with a phone app that works offline and sends WhatsApp reminders in two taps.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
