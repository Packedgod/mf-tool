import type { Metadata } from "next";
import "./globals.css";
import "./polish.css";

export const metadata: Metadata = {
  title: "MF Manager Decision Intelligence",
  description: "Live manager-first mutual fund analytics using MFapi.in, AMFI, Yahoo Finance and optional FMP."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
