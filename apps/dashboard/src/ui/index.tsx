/**
 * The small shared component set (BUILD-PLAN §7.1).
 *
 * BUILD-PLAN puts these in packages/ui, and that is still where they belong. They are here
 * because three front ends were being built at the same time and a shared package written by
 * three agents at once is a merge conflict, not a component set. The token names and the class
 * names are the shared ones, so the move is a copy (decisions-made-overnight.md, task 07b).
 *
 * No component library, no Tailwind, no CSS-in-JS: a class name and a stylesheet.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import './ui.css';

/* ------------------------------------------------------------------ button */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'default' | 'primary' | 'danger';
}

export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const classes = ['mc-button', variant === 'default' ? '' : `mc-button--${variant}`, className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button type="button" {...rest} className={classes} />;
}

/* ------------------------------------------------------------- field/input */

export interface FieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

/** label + control + hint + error, so no form has to lay that out for itself. */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="mc-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined && error === undefined ? <span className="mc-hint">{hint}</span> : null}
      {error !== undefined ? <span className="mc-error">{error}</span> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={['mc-input', className ?? ''].filter(Boolean).join(' ')} />;
}

/* -------------------------------------------------------------- containers */

export function Card({ flush = false, children }: { readonly flush?: boolean; readonly children: ReactNode }) {
  return <div className={flush ? 'mc-card mc-card--flush' : 'mc-card'}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="mc-pageheader">
      <div>
        <h1>{title}</h1>
        {subtitle !== undefined ? <p>{subtitle}</p> : null}
      </div>
      <div className="mc-spacer" />
      {actions}
    </header>
  );
}

/* ------------------------------------------------------------------ status */

export function Banner({
  tone,
  title,
  children,
}: {
  readonly tone: 'info' | 'warning' | 'danger';
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`mc-banner mc-banner--${tone}`} role="status">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <div className="mc-empty">{children}</div>;
}

export function Spinner() {
  return <span className="mc-spinner" aria-label="loading" />;
}

/* ------------------------------------------------------------------- table */

export function Table({ head, children }: { readonly head: ReactNode; readonly children: ReactNode }) {
  return (
    <table className="mc-table">
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/* ------------------------------------------------------------------- money */

/**
 * Minor units and a currency code, never a float (contracts/common.ts). Formatting is the only
 * place the two are put back together, so nothing else has to know that 1250 means 12.50.
 */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
}

export function Money({ minor, currency }: { readonly minor: number; readonly currency: string }) {
  return <span className="mc-num">{formatMoney(minor, currency)}</span>;
}
