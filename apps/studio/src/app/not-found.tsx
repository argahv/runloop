import type { Metadata } from 'next';
import { ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/States';

export const metadata: Metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <EmptyState
      icon="slash"
      title="This page does not exist"
      actions={
        <ButtonLink href="/overview" icon="overview">
          Go to the overview
        </ButtonLink>
      }
    >
      <p>Runloop Studio has Overview, Live World, Traces, Integrations and Settings.</p>
    </EmptyState>
  );
}
