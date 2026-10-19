import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  // Emit overview/index.html (not overview.html) so every static file server resolves the routes.
  trailingSlash: true,
  reactStrictMode: true,
  // Don't (re)generate an AGENTS.md file on `next dev`.
  agentRules: false,
  // The dev badge would cover the sidebar's runtime status.
  devIndicators: false,
  transpilePackages: [
    '@runloop-world/core',
    '@runloop-world/events',
    '@runloop-world/replay',
    '@runloop-world/sim',
    '@runloop-world/town',
    '@runloop-world/world-engine',
  ],
  turbopack: {
    root: path.join(import.meta.dirname, '../..'),
  },
  images: { unoptimized: true },
};

export default nextConfig;
