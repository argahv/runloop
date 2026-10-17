import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import AppShell from '../components/AppShell';
import { THEME_INIT_SCRIPT } from '../state/prefs';
import './tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Runloop Studio', template: '%s · Runloop Studio' },
  description: 'Watch real agent work, inspect the trace, replay what happened.',
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#101114' },
    { media: '(prefers-color-scheme: light)', color: '#f4f5f7' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Geist and Geist Mono are self-hosted by next/font (no network font fetches).
  // data-theme is set by the inline script before first paint, so it differs from the server HTML.
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
