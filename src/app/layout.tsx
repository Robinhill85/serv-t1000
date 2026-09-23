import type { Metadata } from "next";
import { Geist, VT323 } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const hudFont = VT323({ variable: "--font-hud", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "T1000: liquid allocation agent",
  description: "An agent that finds your idle stablecoins, reasons about where they should live with SERV, and moves them onchain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${hudFont.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
