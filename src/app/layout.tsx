import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Silverline | Source-grounded assistant",
  description: "Explore a clearly fictional Silverline board and financial-results document collection.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
