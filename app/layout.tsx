import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ManagerLens — MF Manager Decision Intelligence",
  description: "Live, manager-first Indian mutual fund analytics using verified AMC manager records, MFapi.in, AMFI, Yahoo Finance validation and optional FMP."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
