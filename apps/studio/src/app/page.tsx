'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { parseDeepLink, routeForDeepLink } from '../state/deeplink';

/** `/` redirects: deep links (?run=&view=…) to their page, everything else to the Overview. */
export default function RootRedirect() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.toString();
    router.replace(`${routeForDeepLink(parseDeepLink(params))}${query ? `?${query}` : ''}`);
  }, [router]);
  return null;
}
