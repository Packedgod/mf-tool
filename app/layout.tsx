import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MF Live Manager Analytics",
  description: "Live Indian mutual fund analytics using MFapi.in, AMFI and optional FMP."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
