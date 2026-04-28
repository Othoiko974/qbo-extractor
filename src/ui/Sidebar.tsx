import React from 'react';
import { useStore } from '../store/store';
import type { Screen } from '../types/domain';
import { Icon } from './Icon';
import { t, useLang } from '../i18n';
import { LangToggle } from './LangToggle';

const NAV: { key: Screen; tKey: string; icon: string }[] = [
  { key: 'dashboard', tKey: 'nav.dashboard', icon: 'home' },
  { key: 'extraction', tKey: 'nav.extraction', icon: 'download' },
  { key: 'review', tKey: 'nav.review', icon: 'alert' },
  { key: 'vendors', tKey: 'nav.vendors', icon: 'tag' },
  { key: 'history', tKey: 'nav.history', icon: 'history' },
  { key: 'settings', tKey: 'nav.settings', icon: 'settings' },
];

export function Sidebar() {
  useLang(); // re-render on language change
  const { companies, activeCompanyKey, setActiveCompany, screen, setScreen, extraction } = useStore();

  const addNewCompany = () => {
    setActiveCompany(null);
    setScreen('connect');
  };

  const reviewCount = extraction.reduce(
    (n, r) => (r.status === 'amb' || r.status === 'nf' || r.status === 'nopj' ? n + 1 : n),
    0,
  );

  return (
    <aside className="sidebar">
      <div
        className="drag"
        style={{ padding: '10px 14px 10px 78px', display: 'flex', alignItems: 'center', gap: 10, minHeight: 52 }}
      >
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11 }}>QBO</div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>QBO Extractor</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Altitude 233</div>
        </div>
      </div>

      <div style={{ padding: '10px 10px 4px' }}>
        <div className="side-h">{t('sidebar.companies')}</div>
        {companies.map((c) => (
          <div
            key={c.key}
            onClick={() => setActiveCompany(c.key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              background: activeCompanyKey === c.key ? '#fff' : 'transparent',
              border: activeCompanyKey === c.key ? '1px solid var(--line)' : '1px solid transparent',
              marginBottom: 2,
            }}
          >
            <span style={{ width: 22, height: 22, borderRadius: 5, background: c.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)' }}>
              {c.initials}
            </span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: activeCompanyKey === c.key ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.label}
            </span>
            <span className={`dot ${c.connected ? 'dot-ok' : 'dot-idle'}`} title={c.connected ? 'Connecté' : 'Déconnecté'} />
          </div>
        ))}
        <button
          className="btn btn-sm btn-ghost"
          onClick={addNewCompany}
          style={{ width: '100%', justifyContent: 'flex-start', marginTop: 4, color: 'var(--muted)' }}
        >
          <Icon name="plus" size={12} /> {t('sidebar.add_company')}
        </button>
      </div>

      <div className="divider-h" style={{ margin: '8px 10px' }} />

      <nav style={{ padding: '4px 0' }}>
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`side-item${screen === n.key ? ' active' : ''}`}
            onClick={() => setScreen(n.key)}
          >
            <Icon name={n.icon} size={14} />
            <span>{t(n.tKey)}</span>
            {n.key === 'review' && reviewCount > 0 && (
              <span
                className="side-badge"
                style={{
                  background: 'var(--warn-soft)',
                  borderColor: '#ead9b4',
                  color: '#6b4710',
                }}
              >
                {reviewCount}
              </span>
            )}
          </div>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--line)',
          fontSize: 10.5,
          color: 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>v0.1.0 · {t('sidebar.local_storage')}</span>
        <span style={{ flex: 1 }} />
        <LangToggle />
      </div>
    </aside>
  );
}
