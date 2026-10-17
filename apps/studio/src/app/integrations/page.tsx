import type { Metadata } from 'next';
import IntegrationsPage from '../../components/pages/IntegrationsPage';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  return <IntegrationsPage />;
}
