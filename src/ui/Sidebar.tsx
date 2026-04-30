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
    activeView,
    activeComptePid,
    setActiveCompany,
    setActiveCompte,
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
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>QBO Extractor</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Altitude 233</div>
        </div>
      </div>

      <ProjectsAndCompanies
        companies={companies}
        projects={projects}
        activeCompanyKey={activeCompanyKey}
        activeView={activeView}
        activeComptePid={activeComptePid}
        onPickCompany={setActiveCompany}
        onPickCompte={setActiveCompte}
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
  activeView,
  activeComptePid,
  onPickCompany,
  onPickCompte,
  onAddCompany,
}: {
  companies: ReturnType<typeof useStore.getState>['companies'];
  projects: Project[];
  activeCompanyKey: string | null;
  activeView: 'company' | 'compte';
  activeComptePid: string | null;
  onPickCompany: (key: string) => void;
  onPickCompte: (projectId: string) => void;
  onAddCompany: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const activeCompany = companies.find((c) => c.key === activeCompanyKey);
  // Active project drives "expanded" state. In Compte view we still
  // anchor on the project being viewed, otherwise on the active
  // company's project.
  const activeProjectId =
    activeView === 'compte' ? activeComptePid : activeCompany?.projectId ?? null;
  const orphans = companies.filter((c) => !c.projectId);

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
        const linked = companies.filter((c) => c.projectId === p.id);
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
                    active={activeView === 'company' && activeCompanyKey === c.key}
                    onClick={() => onPickCompany(c.key)}
                  />
                ))}
                <CompteItem
                  projectName={p.name}
                  active={activeView === 'compte' && activeComptePid === p.id}
                  onClick={() => onPickCompte(p.id)}
                />
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
              active={activeView === 'company' && activeCompanyKey === c.key}
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

// Virtual "Compte projet" entry that sits at the bottom of every project
// group in the sidebar. Visually distinct from real companies — italic
// label, neutral square instead of the company-color avatar — so the
// user reads it as a project bucket rather than a switchable workspace.
// Clicking it puts the Dashboard into Compte view (filter to fallback
// rows; extraction guarded with a modal).
function CompteItem({
  projectName,
  active,
  onClick,
}: {
  projectName: string;
  active: boolean;
  onClick: () => void;
}) {
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
      title="Vue virtuelle : factures sans entreprise rattachée du projet. Pas d'extraction QBO possible."
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: 'var(--paper-2)',
          color: 'var(--muted)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--line)',
        }}
      >
        <Icon name="folder" size={11} />
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12.5,
          fontStyle: 'italic',
          fontWeight: active ? 600 : 500,
          color: 'var(--muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        Compte {projectName}
      </span>
    </div>
  );
}

function CompanyItem({
  company,
  active,
  onClick,
}: {
  company: ReturnType<typeof useStore.getState>['companies'][number];
  active: boolean;
  onClick: () => void;
}) {
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
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: company.color,
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'var(--mono)',
        }}
      >
        {company.initials}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {company.label}
      </span>
      <span
        className={`dot ${company.connected ? 'dot-ok' : 'dot-idle'}`}
        title={company.connected ? 'Connecté' : 'Déconnecté'}
      />
    </div>
  );
}

