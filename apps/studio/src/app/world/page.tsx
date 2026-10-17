import type { Metadata } from 'next';
import WorldPage from '../../components/pages/WorldPage';

export const metadata: Metadata = { title: 'Live World' };

export default function Page() {
  return <WorldPage />;
}
