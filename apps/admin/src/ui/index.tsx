/**
 * The console's component set: six components, plain CSS, no library (BUILD-PLAN §7.1).
 *
 * They are deliberately dumb -- a class name and children. Everything visual is a token in
 * styles/tokens.css, so this file has no colours and no spacing values in it.
 */
import type { ReactNode } from 'react';

import type { LicenceStatus, TenantStatus } from '../api/schemas.js';

export function PageHeader(props: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mc-page-header">
      <div className="mc-page-header__text">
        <h1>{props.title}</h1>
        {props.subtitle === undefined ? null : <p>{props.subtitle}</p>}
      </div>
      {props.actions === undefined ? null : (
        <div className="mc-page-header__actions">{props.actions}</div>
      )}
    </header>
  );
}

export function Card(props: { title?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="mc-card">
      {props.title === undefined ? null : <div className="mc-card__head">{props.title}</div>}
      <div className="mc-card__body">{props.children}</div>
    </section>
  );
}

export function Banner(props: {
  tone: 'info' | 'warning' | 'danger';
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`mc-banner mc-banner--${props.tone}`} role="status">
      <div className="mc-banner__body">{props.children}</div>
    </div>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  testId?: string;
}): ReactNode {
  const tone = props.tone ?? 'default';
  return (
    <button
      type={props.type ?? 'button'}
      className={tone === 'default' ? 'mc-button' : `mc-button mc-button--${tone}`}
      disabled={props.disabled ?? false}
      data-testid={props.testId}
      {...(props.onClick === undefined ? {} : { onClick: props.onClick })}
    >
      {props.children}
    </button>
  );
}

export function EmptyState(props: { children: ReactNode }): ReactNode {
  return <p className="mc-empty">{props.children}</p>;
}

/**
 * `pending`, `active` and `passive` are three different answers and the console shows all three.
 * Collapsing "has not paid yet" into "was suspended" would hide which person fixes it (CG3).
 */
export function StatusPill(props: {
  value: TenantStatus | LicenceStatus | 'unknown';
  testId?: string;
}): ReactNode {
  const tone =
    props.value === 'active'
      ? 'active'
      : props.value === 'passive'
        ? 'passive'
        : props.value === 'pending'
          ? 'pending'
          : 'neutral';
  return (
    <span className={`mc-pill mc-pill--${tone}`} data-testid={props.testId}>
      {props.value}
    </span>
  );
}
