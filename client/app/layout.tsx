import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Playwright Runner UI",
  description: "Local runner for Playwright test repositories.",
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
