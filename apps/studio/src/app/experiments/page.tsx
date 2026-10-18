import type { Metadata } from 'next';
import ExperimentsPage from '../../components/pages/ExperimentsPage';

export const metadata: Metadata = { title: 'Experiments' };

export default function Page() {
  return <ExperimentsPage />;
}
