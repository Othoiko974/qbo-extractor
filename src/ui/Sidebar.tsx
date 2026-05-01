import React, { useState } from 'react';
import { useStore } from '../store/store';
import type { Screen, Project } from '../types/domain';
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
  const {
    companies,
    projects,
    activeCompanyKey,
    setActiveCompany,
    screen,
    setScreen,
    extraction,
  } = useStore();

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
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>QBO Extractor</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Altitude 233</div>
        </div>
        <button
          className="no-drag"
          onClick={() => {
            void window.qboApi.openDevtools?.();
          }}
          title="Ouvrir DevTools (console + erreurs)"
          style={{
            background: 'transparent',
            border: '1px solid var(--line)',
            borderRadius: 6,
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 10,
            padding: '3px 8px',
            fontFamily: 'var(--mono)',
            letterSpacing: '0.04em',
          }}
        >
          DEV
        </button>
      </div>

      <ProjectsAndCompanies
        companies={companies}
        projects={projects}
        activeCompanyKey={activeCompanyKey}
        onPickCompany={setActiveCompany}
        onAddCompany={addNewCompany}
      />

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

// Group companies under their project header. With a single project the
// rendering collapses to a flat list (the project name shows as a quiet
// section header to surface budget context). With multiple projects each
// gets a collapsible group; the active company's project starts open.
function ProjectsAndCompanies({
  companies,
  projects,
  activeCompanyKey,
  onPickCompany,
  onAddCompany,
}: {
  companies: ReturnType<typeof useStore.getState>['companies'];
  projects: Project[];
  activeCompanyKey: string | null;
  onPickCompany: (key: string) => void;
  onAddCompany: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const activeCompany = companies.find((c) => c.key === activeCompanyKey);
  const activeProjectId = activeCompany?.projectId ?? null;
  // Owners are pinned at the bottom of each project group regardless
  // of their sort_order, so the user reads "real sisters first, fallback
  // last" — matches the chip rendering hierarchy.
  const orphans = companies.filter((c) => !c.projectId && !c.isProjectOwner);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ padding: '10px 10px 4px' }}>
      {projects.map((p) => {
        // Sort: real sisters first, owner last. The owner stays in the
        // same list as everything else (clickable, switchable like any
        // other company) — what changes is its visual treatment, not
        // its mechanics.
        const linked = companies
          .filter((c) => c.projectId === p.id)
          .sort((a, b) => Number(!!a.isProjectOwner) - Number(!!b.isProjectOwner));
        const isActive = p.id === activeProjectId;
        const isCollapsed = collapsed.has(p.id) && !isActive;
        return (
          <div key={p.id} style={{ marginBottom: 6 }}>
            <div
              onClick={() => projects.length > 1 && toggle(p.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                fontSize: 10.5,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                cursor: projects.length > 1 ? 'pointer' : 'default',
                userSelect: 'none',
              }}
              title={
                p.budgetSource === 'gsheets' && p.gsheetsWorkbookName
                  ? `Sheets : ${p.gsheetsWorkbookName}`
                  : p.budgetSource === 'excel' && p.excelPath
                    ? `Excel : ${p.excelPath}`
                    : 'Aucune source de budget configurée'
              }
            >
              {projects.length > 1 && (
                <span style={{ fontSize: 9 }}>{isCollapsed ? '▶' : '▼'}</span>
              )}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ fontSize: 9.5, fontWeight: 500 }}>{linked.length}</span>
            </div>
            {!isCollapsed && (
              <div>
                {linked.map((c) => (
                  <CompanyItem
                    key={c.key}
                    company={c}
                    active={activeCompanyKey === c.key}
                    onClick={() => onPickCompany(c.key)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {orphans.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div
            style={{
              padding: '4px 6px',
              fontSize: 10.5,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
            }}
            title="Compagnies sans projet rattaché — Réglages → Projets pour assigner."
          >
            Sans projet
          </div>
          {orphans.map((c) => (
            <CompanyItem
              key={c.key}
              company={c}
              active={activeCompanyKey === c.key}
              onClick={() => onPickCompany(c.key)}
            />
          ))}
        </div>
      )}

      <button
        className="btn btn-sm btn-ghost"
        onClick={onAddCompany}
        style={{ width: '100%', justifyContent: 'flex-start', marginTop: 4, color: 'var(--muted)' }}
      >
        <Icon name="plus" size={12} /> {t('sidebar.add_company')}
      </button>
    </div>
  );
}

// Renders a clickable company entry in the sidebar. Project owners
// (the auto-created "Compte [name]" companies) get a distinct visual
// treatment — folder icon avatar, italic label, muted color — so the
// user reads them as the project's fallback bucket. Mechanics are
// otherwise identical: click sets active, connection dot reflects
// QBO-connected status (red when not, green when so), extraction is
// blocked the same way as for any disconnected company.
function CompanyItem({
  company,
  active,
  onClick,
}: {
  company: ReturnType<typeof useStore.getState>['companies'][number];
  active: boolean;
  onClick: () => void;
}) {
  const isOwner = !!company.isProjectOwner;
  const test = useStore((s) => s.connectionTests[company.key]);
  const testCompanyConnection = useStore((s) => s.testCompanyConnection);

  // Live test result wins over the stale `company.connected` DB flag —
  // that flag was set the last time OAuth succeeded and stays sticky
  // even if the API key was revoked or proxy URL changed.
  const dotKind: 'ok' | 'fail' | 'testing' | 'unknown' = test
    ? test.status
    : company.connected
    ? 'unknown' // green-ish but unverified
    : 'fail'; // never connected — red

  const dotClass =
    dotKind === 'ok'
      ? 'dot-ok'
      : dotKind === 'fail'
      ? 'dot-idle'
      : dotKind === 'testing'
      ? 'dot-pulse'
      : 'dot-stale';

  const dotTitle = test
    ? test.status === 'testing'
      ? 'Test en cours…'
      : test.status === 'ok'
      ? `Connecté (testé il y a ${Math.max(1, Math.round((Date.now() - test.testedAt) / 1000))}s)`
      : `Échec : ${test.error ?? 'erreur'} — clique pour re-tester`
    : company.connected
    ? 'Marqué connecté (non vérifié) — clique pour tester maintenant'
    : 'Non connecté — clique pour tester quand même';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? '#fff' : 'transparent',
        border: active ? '1px solid var(--line)' : '1px solid transparent',
        marginBottom: 2,
        marginLeft: 4,
      }}
      title={
        isOwner
          ? company.connected
            ? `${company.label} — bucket projet, connecté`
            : `${company.label} — bucket projet, non connecté (extraction désactivée)`
          : undefined
      }
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: isOwner ? 'var(--paper-2)' : company.color,
          color: isOwner ? 'var(--muted)' : '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'var(--mono)',
          border: isOwner ? '1px dashed var(--line)' : 'none',
        }}
      >
        {isOwner ? <Icon name="folder" size={11} /> : company.initials}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12.5,
          fontStyle: isOwner ? 'italic' : 'normal',
          fontWeight: active ? 600 : 500,
          color: isOwner ? 'var(--muted)' : 'inherit',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {company.label}
      </span>
      <span
        className={`dot ${dotClass}`}
        title={dotTitle}
        onClick={(e) => {
          e.stopPropagation(); // don't trigger the company-row activation
          if (test?.status !== 'testing') void testCompanyConnection(company.key);
        }}
        style={{ cursor: 'pointer' }}
      />
    </div>
  );
}

