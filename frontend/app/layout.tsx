import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";

import "./globals.css";
// Second, so the theme layer wins over Tailwind's preflight.
import "./theme.css";

// Loaded through next/font rather than a CSS @import: the file is served
// from our own origin, so there is no extra connection to Google and no
// flash of the fallback face on first paint.
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin", "cyrillic"],
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
      className={`${interTight.variable} h-full`}
      // One face everywhere. "SF Pro Text" used to sit at the front of
      // this stack, which meant the interface rendered in one typeface on
      // Apple hardware and another on everything else — the same file
      // looking like two different products. Inter Tight is served from
      // our own origin, so it is identical on every machine.
      //
      // Noto Sans SC sits behind it, not in front: a browser walks the
      // stack per character and takes the first font that has the glyph.
      // Latin and Cyrillic hit Inter Tight; Chinese falls through to Noto.
      style={
        {
          "--font-body": `var(--font-inter-tight), "Noto Sans SC", system-ui, sans-serif`,
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