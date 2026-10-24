import type { Metadata, Viewport } from 'next';
import { Archivo } from 'next/font/google';
import { site } from '@/lib/content';
import './globals.css';

/**
 * One typeface for the whole page, worked hard across its weight range.
 *
 * Archivo is a grotesque in the Akzidenz line — the family Swiss typography
 * was actually set in, before Helvetica — and it holds up at 800 without the
 * counters filling in, which is what the display type needs. A second face
 * would only dilute it.
 */
const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-archivo',
  weight: ['400', '500', '600', '700', '800'],
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} — ${site.tagline}`,
    template: `%s — ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  authors: [{ name: site.author, url: site.repoUrl }],
  creator: site.author,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: site.url,
    siteName: site.name,
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
  },
  /* The app's own icon (src-tauri/icons/app-icon.png) at 180px: Apple's
     touch-icon size, and enough for every favicon. */
  icons: {
    icon: [{ url: '/logo.png', type: 'image/png' }],
    apple: '/logo.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="bg-paper text-ink antialiased">
        <a
          href="#short-version"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
