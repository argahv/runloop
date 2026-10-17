import type { Metadata } from 'next';
import TracesPage from '../../components/pages/TracesPage';

export const metadata: Metadata = { title: 'Traces' };

export default function Page() {
  return <TracesPage />;
}
