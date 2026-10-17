import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  transpilePackages: [
    '@runloop-world/core',
    '@runloop-world/events',
    '@runloop-world/replay',
    '@runloop-world/world-engine',
  ],
  turbopack: {
    root: path.join(import.meta.dirname, '../..'),
  },
  images: { unoptimized: true },
};

export default nextConfig;
