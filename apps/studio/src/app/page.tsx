import type { Metadata } from 'next';
import WorldHome from '../components/world/WorldHome';

export const metadata: Metadata = { title: 'Town' };

/** `/` is the town (plan §5). Old run links to `/` are sent on to their page by WorldHome. */
export default function Page() {
  return <WorldHome />;
}
