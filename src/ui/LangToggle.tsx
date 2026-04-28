import React from 'react';
import { useLang, setLang } from '../i18n';

// Compact pill-toggle FR / EN. Matches the design mockup: two segments
// inside a rounded chip, the active one filled with --ink/inverted text.
export function LangToggle() {
  const lang = useLang();
  return (
    <div
      role="group"
      aria-label="Language"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: 999,
        padding: 2,
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: 'var(--mono)',
        letterSpacing: '0.04em',
      }}
    >
      <Seg active={lang === 'fr'} onClick={() => setLang('fr')}>FR</Seg>
      <Seg active={lang === 'en'} onClick={() => setLang('en')}>EN</Seg>
    </div>
  );
}

function Seg({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        appearance: 'none',
        background: active ? 'var(--ink)' : 'transparent',
        color: active ? '#fff' : 'var(--muted)',
        border: 'none',
        padding: '3px 9px',
        borderRadius: 999,
        cursor: 'pointer',
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: 'inherit',
        letterSpacing: 'inherit',
      }}
    >
      {children}
    </button>
  );
}
