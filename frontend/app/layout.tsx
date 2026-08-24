import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

import "./globals.css";
// Second, so the theme layer wins over Tailwind's preflight.
import "./theme.css";

// Loaded through next/font rather than a CSS @import: the file is served
// from our own origin, so there is no extra connection to Google and no
// flash of the fallback face on first paint.
//
// Plex is not a variable font on Google Fonts, so the weights are listed
// by hand. Three for the interface, two for mono: every weight listed
// here is a file the browser may have to fetch, and a weight nothing
// uses is dead payload.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Same superfamily on purpose. The small uppercase labels on /upload are
// mono, and a mono from an unrelated family reads as a second voice in
// the interface. Before this, --font-mono was a system stack, which meant
// those labels rendered differently on every machine.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LecTrack-ZH",
  description: "Semantic search and Q&A over Chinese engineering lectures",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // h-full on BOTH html and body. A percentage height resolves against
      // the parent's height, so `body { height: 100% }` under an html of
      // auto height computes to auto — the shell then collapses to its
      // content and the composer rides up under the last answer instead
      // of staying pinned to the bottom of the viewport.
      className={`${plexSans.variable} ${plexMono.variable} h-full`}
      // One face everywhere, served from our own origin, so the interface
      // is identical on every machine.
      //
      // Noto Sans SC sits behind it, not in front: a browser walks the
      // stack per character and takes the first font that has the glyph.
      // Latin and Cyrillic hit Plex; Chinese falls through to Noto.
      style={
        {
          "--font-body": `var(--font-plex-sans), "Noto Sans SC", system-ui, sans-serif`,
          "--font-mono": `var(--font-plex-mono), ui-monospace, monospace`,
        } as React.CSSProperties
      }
    >
      {/* h-full on both: the chat is a fixed-height shell with its own
          inner scroll, so the composer stays pinned to the bottom of the
          viewport instead of the page growing and pushing it down. */}
      <body className="h-full">{children}</body>
    </html>
  );
}