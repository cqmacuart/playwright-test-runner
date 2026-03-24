import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Playwright Runner UI | Modern Test Orchestration",
  description: "High-performance local runner for Playwright test suites.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
