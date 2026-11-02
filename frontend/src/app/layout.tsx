import type { Metadata } from "next";
import { Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ScrollProgress } from "@/components/ScrollProgress";
import { PageShell } from "@/components/PageShell";
import { Providers } from "./providers";

const sans = Instrument_Sans({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: { default: "NOMA — Give AI power. Not your privacy.", template: "%s · NOMA" },
  description:
    "The next generation of privacy technology. Discover digital services, delegate tasks to AI, and stay in control of your identity, data, and permissions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:border focus:border-accent focus:bg-bg focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:tracking-widest focus:text-accent focus:uppercase"
        >
          Skip to content
        </a>
        <ScrollProgress />
        <Providers>
          <SiteHeader />
          <main id="main" className="flex-1">
            <PageShell>{children}</PageShell>
          </main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
