import Link from 'next/link';
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

/** Class names for a button look (also used by links styled as buttons). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', iconOnly = false, extra?: string): string {
  return [styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : '', extra ?? ''].filter(Boolean).join(' ');
}

interface CommonProps {
  /** Lime primary is for the one main action on a screen. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Icon-only buttons must carry an aria-label. */
  iconOnly?: boolean;
  trailing?: ReactNode;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & CommonProps & { busy?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconOnly, trailing, busy, className, children, type, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClass(variant, size, iconOnly, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon && <Icon name={busy ? 'refresh' : icon} size={size === 'sm' ? 14 : 16} className={busy ? styles.spin : undefined} />}
      {!iconOnly && children}
      {trailing}
    </button>
  );
});

export type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & CommonProps & { href: string };

/** A navigation link that looks like a button. */
export function ButtonLink({ variant, size, icon, iconOnly, trailing, className, children, href, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClass(variant, size, iconOnly, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {!iconOnly && children}
      {trailing}
    </Link>
  );
}
