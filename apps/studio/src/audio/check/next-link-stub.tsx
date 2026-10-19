/** The sound board runs outside Next: `next/link` is a plain anchor here (aliased in render-check.mjs). */
import { forwardRef, type AnchorHTMLAttributes } from 'react';

const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link(props, ref) {
  return <a ref={ref} {...props} />;
});
export default Link;
