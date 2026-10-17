import type { StatusView } from '../state/view';

/** Icon + text status pill (colour comes from the tone and is never the only signal). */
export default function StatusBadge({ view, className }: { view: StatusView; className?: string }) {
  return (
    <span className={className ? `badge ${className}` : 'badge'} data-tone={view.tone}>
      <span aria-hidden="true">{view.icon}</span>
      {view.text}
    </span>
  );
}
