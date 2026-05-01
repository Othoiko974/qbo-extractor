import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon, fmtCurrency } from '../Icon';
import type { BudgetRow } from '../../types/domain';
import { t, useLang } from '../../i18n';
import { rowBelongsToActiveCompany, rowDestinationLabel } from '../../shared/entity';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { Tooltip } from '../Tooltip';

// Per-state chips on the Dashboard let the user pivot between the
// six lifecycle states a budget row can be in. "todo" lumps together
// rows that haven't been touched (no PJ, no extraction status); the
// other narrow chips isolate one specific state at a time so the
// user can answer questions like "which rows did we extract last
// week?" or "which ambiguous rows still need a click?".
type Filter =
  | 'todo'        // no PJ in budget AND no successful extraction yet
  | 'budget_pj'   // budget already says PJ=Oui
  | 'extracted'   // pulled from QBO in a prior run (status='ok'), not in budget
  | 'amb'         // multiple QBO candidates — awaiting user resolution
  | 'nf'          // QBO returned nothing on the last run
  | 'nopj'        // QBO txn found but no attachment on it
  | 'all';
type EntityScope = 'mine' | 'all';
const ALL_SHEETS = '__ALL__';

export function Dashboard() {
  useLang(); // re-render on language change
  const {
    budget,
    companies,
    activeCompanyKey,
    lastSync,
    loading,
    error,
    resyncBudget,
    startExtraction,
    setScreen,
  } = useStore();
  const [filter, setFilter] = useState<Filter>('todo');
  const [entityScope, setEntityScope] = useState<EntityScope>('mine');
  const [sheet, setSheet] = useState<string>(ALL_SHEETS);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const launchBtnRef = useRef<HTMLButtonElement>(null);
  // True once the inline launch button has scrolled out of view — drives
  // the bottom-right floating FAB. We use IntersectionObserver so the FAB
  // can fade in only when the user actually loses sight of the action.
  const [launchOffscreen, setLaunchOffscreen] = useState(false);

  const company = companies.find((c) => c.key === activeCompanyKey);
  // Companies in the same project as active — needed by the
  // owner-mode filter to detect "no real sister claims this row".
  // Falls back to the full list for orphan companies (no project).
  const projectCompanies = useMemo(() => {
    if (!company?.projectId) return companies;
    return companies.filter((c) => c.projectId === company.projectId);
  }, [companies, company?.projectId]);

  const sheets = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of budget) {
      if (!seen.has(r.sheet)) {
        seen.add(r.sheet);
        out.push(r.sheet);
      }
    }
    return out;
  }, [budget]);

  // Rows visible after sheet filter — basis for stats and filter tabs.
  const sheetFiltered = useMemo(() => {
    if (sheet === ALL_SHEETS) return budget;
    return budget.filter((r) => r.sheet === sheet);
  }, [budget, sheet]);

  // "Mes entreprises" filter — semantics differ by company kind:
  //   - regular sister: direct alias match.
  //   - project owner (auto-created Compte): inverse — claims every
  //     row that no real sister in the project claims.
  // The "all" toggle still shows everything so the user can audit the
  // full project budget regardless of which entry is selected.
  const rowIsMine = (bookingEntity: string | null | undefined): boolean => {
    if (!company) return true;
    return rowBelongsToActiveCompany(bookingEntity, company, projectCompanies);
  };

  const entityFiltered = useMemo(() => {
    if (entityScope === 'all') return sheetFiltered;
    return sheetFiltered.filter((r) => rowIsMine(r.bookingEntity));
  }, [sheetFiltered, entityScope, company, projectCompanies]);

  // "Hors entreprise" KPI — counts rows that don't belong to the
  // current view. Used to surface a tooltip / nudge toward the "all"
  // scope when the filter is hiding non-trivial volume.
  const foreignCount = useMemo(() => {
    return sheetFiltered.reduce((n, r) => (rowIsMine(r.bookingEntity) ? n : n + 1), 0);
  }, [sheetFiltered, company, projectCompanies]);

  // Per-row classifier. "todo" is the catch-all for everything
  // outside the named states — typical for rows the user hasn't
  // touched yet. Order matters: hasAttachment from the budget wins
  // over extraction history (the spreadsheet is authoritative for
  // "the file is already filed").
  const classify = (r: BudgetRow): Filter => {
    if (r.hasAttachment) return 'budget_pj';
    if (r.extractionStatus === 'ok') return 'extracted';
    if (r.extractionStatus === 'amb') return 'amb';
    if (r.extractionStatus === 'nf') return 'nf';
    if (r.extractionStatus === 'nopj') return 'nopj';
    return 'todo';
  };
  const visible = useMemo(() => {
    if (filter === 'all') return entityFiltered;
    return entityFiltered.filter((r) => classify(r) === filter);
  }, [entityFiltered, filter]);

  // Per-state counts so the chips can show their badges. Computed
  // once over entityFiltered (the company-scoped set) — same source
  // of truth as the visible list.
  const counts = useMemo(() => {
    const out: Record<Filter, number> = {
      todo: 0,
      budget_pj: 0,
      extracted: 0,
      amb: 0,
      nf: 0,
      nopj: 0,
      all: entityFiltered.length,
    };
    for (const r of entityFiltered) out[classify(r)]++;
    return out;
  }, [entityFiltered]);

  // Group split-sibling rows under a collapsible header so a "Home Depot"
  // Excel cell listing 4 invoices shows as one summary line with a chevron
  // rather than four separate rows with $0 on three of them.
  type Item =
    | { kind: 'single'; row: BudgetRow }
    | { kind: 'group'; id: string; members: BudgetRow[]; total: number };
  const items = useMemo<Item[]>(() => {
    const seen = new Map<string, BudgetRow[]>();
    const out: Item[] = [];
    for (const r of visible) {
      if (r.splitGroupId && (r.splitGroupSize ?? 1) > 1) {
        let bucket = seen.get(r.splitGroupId);
        if (!bucket) {
          bucket = [];
          seen.set(r.splitGroupId, bucket);
          out.push({ kind: 'group', id: r.splitGroupId, members: bucket, total: 0 });
        }
        bucket.push(r);
      } else {
        out.push({ kind: 'single', row: r });
      }
    }
    for (const it of out) {
      if (it.kind === 'group') {
        it.members.sort((a, b) => (a.splitIndex ?? 0) - (b.splitIndex ?? 0));
        it.total = it.members.reduce((s, r) => s + r.amount, 0);
      }
    }
    return out;
  }, [visible]);

  // KPI "without PJ" tile — counts rows still requiring human / QBO
  // action. Mirrors the "todo" chip but rendered separately as a top-
  // line dashboard signal.
  const missingCount = counts.todo + counts.amb + counts.nf;

  const toggleRow = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupSelection = (memberIds: string[]) => {
    setSelection((prev) => {
      const next = new Set(prev);
      const allIn = memberIds.every((id) => next.has(id));
      if (allIn) for (const id of memberIds) next.delete(id);
      else for (const id of memberIds) next.add(id);
      return next;
    });
  };

  const toggleGroupExpanded = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (visible.every((r) => selection.has(r.id)) && visible.length > 0) {
      setSelection((prev) => {
        const next = new Set(prev);
        for (const r of visible) next.delete(r.id);
        return next;
      });
    } else {
      setSelection((prev) => {
        const next = new Set(prev);
        for (const r of visible) next.add(r.id);
        return next;
      });
    }
  };

  const launch = () => {
    if (selection.size === 0) return;
    if (!company) return;
    // Project owner without a QBO connection — extraction would have
    // nowhere to go. Nudge the user to OAuth it (or pick a real
    // sister) instead of failing silently downstream.
    if (company.isProjectOwner && !company.connected) {
      window.alert(
        `${company.label} n'est pas encore connecté à QuickBooks. Configure la connexion QBO de ce compte pour activer l'extraction, ou sélectionne une vraie compagnie du projet dans la sidebar.`,
      );
      return;
    }
    // Partition the selection by entity. We refuse to send a row to QBO if
    // its booking entity doesn't match the active company — those would
    // 100% return "not found" and waste API budget.
    const ids = Array.from(selection);
    const selectedRows = ids
      .map((id) => budget.find((b) => b.id === id))
      .filter((r): r is BudgetRow => !!r);
    // Drop rows already extracted in a prior run (status = 'ok'). Re-
    // running them would just re-download the same file. The user can
    // still re-extract by deleting the local file + re-launching, or by
    // explicitly opting in via the confirm below.
    const alreadyOkIds = new Set(
      selectedRows.filter((r) => r.extractionStatus === 'ok').map((r) => r.id),
    );
    let effectiveRows = selectedRows;
    if (alreadyOkIds.size > 0) {
      const reextract = window.confirm(
        `${alreadyOkIds.size} ligne(s) déjà extraite(s) avec succès lors d'un run précédent — re-télécharger ?\n\nOK = re-télécharger.\nAnnuler = ignorer ces lignes (extraire seulement les autres).`,
      );
      if (!reextract) {
        effectiveRows = selectedRows.filter((r) => !alreadyOkIds.has(r.id));
      }
    }
    const matching = effectiveRows.filter((r) =>
      rowBelongsToActiveCompany(r.bookingEntity, company, projectCompanies),
    );
    const foreign = effectiveRows.length - matching.length;
    if (foreign > 0) {
      const ok = window.confirm(
        t('dashboard.launch.confirm_mixed', {
          foreign,
          matching: matching.length,
          company: company.label,
        }),
      );
      if (!ok) return;
    }
    if (matching.length === 0) return;
    void startExtraction(matching.map((r) => r.id));
  };

  const resync = () => {
    void resyncBudget();
  };

  // Keyboard shortcuts: ⌘A select-all, Enter launch, 1/2/3 PJ filters,
  // Esc clear selection.
  useKeyboardShortcuts([
    {
      key: 'a',
      meta: true,
      handler: () => toggleAll(),
      label: t('shortcuts.dashboard.select_all'),
      group: t('shortcuts.group.selection'),
    },
    {
      key: 'Enter',
      handler: () => {
        if (selection.size > 0 && company?.connected) launch();
      },
      label: t('shortcuts.dashboard.launch'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: '1',
      handler: () => setFilter('todo'),
      label: t('shortcuts.dashboard.filter_missing'),
      group: t('shortcuts.group.filters'),
    },
    {
      key: '2',
      handler: () => setFilter('extracted'),
      label: t('shortcuts.dashboard.filter_has'),
      group: t('shortcuts.group.filters'),
    },
    {
      key: '3',
      handler: () => setFilter('all'),
      label: t('shortcuts.dashboard.filter_all'),
      group: t('shortcuts.group.filters'),
    },
    {
      key: 'Escape',
      handler: () => {
        if (selection.size > 0) setSelection(new Set());
      },
      label: t('shortcuts.dashboard.deselect'),
      group: t('shortcuts.group.selection'),
    },
  ]);

  // Reset selection when sheet filter or entity scope changes — keeping
  // hidden rows in the selection set could quietly let the user launch
  // an extraction on rows they can't see.
  useEffect(() => {
    setSelection(new Set());
  }, [sheet, entityScope]);

  // Track inline launch button visibility so the floating FAB fades in only
  // once the original action scrolls out of sight. rootMargin tightens the
  // detection so the FAB doesn't blink in/out on near-edge scrolls.
  useEffect(() => {
    const el = launchBtnRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setLaunchOffscreen(!entry.isIntersecting),
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // Re-observe if rows change (DOM relayout) — visible state stays accurate.
  }, [items.length]);

  const needsBudgetSetup = !loading && budget.length === 0 && !error;
  const sourceLabel = company?.gsheetsWorkbookName
    ? `${company.gsheetsWorkbookName} · Google Sheets`
    : company?.excelPath
      ? `${company.excelPath.split('/').pop()} · Excel local`
      : '—';
  const sheetsCount = sheets.length;
  const allChecked = visible.length > 0 && visible.every((r) => selection.has(r.id));
  const someChecked = visible.some((r) => selection.has(r.id)) && !allChecked;

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <span>{company?.label ?? t('dashboard.no_company')}</span>
          <span>›</span>
          <b>{t('dashboard.title')}</b>
          {company?.connected && (
            <span
              className="chip chip-ok"
              style={{ marginLeft: 8, fontSize: 10.5, padding: '2px 7px' }}
            >
              <span className="dot dot-ok" /> {t('dashboard.connected')}
            </span>
          )}
        </div>
        <div className="topbar-spacer" />
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setScreen('gsheets')}
          disabled={!company}
          title={t('dashboard.change_source')}
        >
          <Icon name="sheet" size={12} /> {t('dashboard.budget_source')}
        </button>
        <button className="btn btn-sm" onClick={resync} disabled={loading || !company}>
          <Icon name="refresh" size={12} />
          {loading ? ` ${t('dashboard.syncing')}` : ` ${t('dashboard.resync')}`}
        </button>
      </div>

      <div className="content pad">
        {error && (
          <div
            className="card-surface"
            style={{
              padding: '12px 14px',
              marginBottom: 12,
              color: 'var(--err)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45 }}>
              {/^ENOENT/i.test(error) || /no such file/i.test(error) ? (
                <>
                  <b>{t('dashboard.file_not_found')}</b> {t('dashboard.file_not_found_desc')}
                  <div className="mono" style={{ marginTop: 4, fontSize: 11.5, color: 'var(--ink)' }}>
                    {company?.excelPath ?? '—'}
                  </div>
                </>
              ) : (
                error
              )}
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setScreen('gsheets')}
              style={{ flexShrink: 0 }}
            >
              <Icon name="sheet" size={12} /> {t('dashboard.change_source')}
            </button>
          </div>
        )}

        {needsBudgetSetup && (
          <div className="card-surface" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              {t('dashboard.no_budget')}
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              {t('dashboard.no_budget_desc')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm btn-primary" onClick={() => setScreen('gsheets')}>
                <Icon name="sheet" size={12} /> {t('dashboard.configure_gsheets')}
              </button>
              <button className="btn btn-sm" onClick={() => setScreen('settings')}>
                <Icon name="settings" size={12} /> {t('nav.settings')}
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <Kpi
            label={t('dashboard.kpi.active_sheet')}
            value={sheet === ALL_SHEETS ? `${t('dashboard.kpi.all_sheets')} (${sheetsCount})` : sheet}
          />
          {/*
            Both numeric KPIs follow the active entity scope so they stay
            consistent with the visible table. The "Lignes totales" tooltip
            still surfaces the wider count (across all entities) when the
            user is in "Mon entreprise" mode.
          */}
          <Kpi
            label={t('dashboard.kpi.total_lines')}
            value={String(entityFiltered.length)}
            title={
              entityScope === 'mine' && foreignCount > 0
                ? `+ ${foreignCount} dans d'autres entités`
                : undefined
            }
          />
          <Kpi
            label={t('dashboard.kpi.with_without_pj')}
            value={`${entityFiltered.length - missingCount} · ${missingCount}`}
            highlight={missingCount > 0}
          />
          <Kpi
            label={t('dashboard.kpi.last_sync')}
            value={relativeTime(lastSync)}
            title={lastSync ? new Date(lastSync).toLocaleString('fr-CA') : undefined}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <label className="kv" style={{ gap: 4 }}>
            <span className="k">{t('dashboard.filter.sheet')}</span>
            <select
              className="input input-sm"
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              style={{ width: 240 }}
            >
              <option value={ALL_SHEETS}>
                {t('dashboard.filter.all_sheets')} ({sheetsCount})
              </option>
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {/* Filter chips: one per lifecycle state. Counts are
              rendered as a small grey badge after the label so the
              user can see at a glance what's hiding behind a chip. */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              marginLeft: 8,
              alignSelf: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <Chip
              label={`À extraire · ${counts.todo}`}
              active={filter === 'todo'}
              onClick={() => setFilter('todo')}
            />
            <Chip
              label={`PJ budget · ${counts.budget_pj}`}
              active={filter === 'budget_pj'}
              onClick={() => setFilter('budget_pj')}
            />
            <Chip
              label={`Extraites · ${counts.extracted}`}
              active={filter === 'extracted'}
              onClick={() => setFilter('extracted')}
            />
            <Chip
              label={`Ambiguës · ${counts.amb}`}
              active={filter === 'amb'}
              onClick={() => setFilter('amb')}
            />
            <Chip
              label={`Introuvables · ${counts.nf}`}
              active={filter === 'nf'}
              onClick={() => setFilter('nf')}
            />
            <Chip
              label={`Sans PJ · ${counts.nopj}`}
              active={filter === 'nopj'}
              onClick={() => setFilter('nopj')}
            />
            <Chip
              label={`Toutes · ${counts.all}`}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
          </div>

          {/* Entity scope toggle — by default we hide rows that belong to
              another company's QBO. The badge surfaces how many would
              appear in "all" mode so the user knows there's content to
              switch entreprise for. */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              marginLeft: 12,
              alignSelf: 'flex-end',
              alignItems: 'center',
              borderLeft: '1px solid var(--line)',
              paddingLeft: 12,
            }}
            title={t('dashboard.entity_scope.tooltip')}
          >
            <Chip
              label={t('dashboard.entity_scope.mine')}
              active={entityScope === 'mine'}
              onClick={() => setEntityScope('mine')}
            />
            <Chip
              label={
                foreignCount > 0
                  ? `${t('dashboard.entity_scope.all')} (+${foreignCount})`
                  : t('dashboard.entity_scope.all')
              }
              active={entityScope === 'all'}
              onClick={() => setEntityScope('all')}
            />
          </div>

          <div className="topbar-spacer" />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            <b style={{ color: 'var(--ink)' }}>{selection.size}</b> / {visible.length}{' '}
            {t('dashboard.selected')}
          </span>
          <button className="btn btn-sm" onClick={toggleAll} disabled={visible.length === 0}>
            {allChecked ? t('dashboard.deselect_all') : t('dashboard.select_all')}
          </button>
          <button
            ref={launchBtnRef}
            className="btn btn-primary btn-sm"
            disabled={selection.size === 0 || !company?.connected}
            onClick={launch}
            style={{ opacity: selection.size === 0 ? 0.5 : 1 }}
            title={
              selection.size > 0
                ? `~${selection.size * 8} requêtes estimées (limite QBO 500/min)`
                : ''
            }
          >
            <Icon name="play" size={12} /> {t('dashboard.launch')} ({selection.size}
            {selection.size > 0 ? ` · ~${selection.size * 8} req` : ''})
          </button>
        </div>

        {/*
          overflow-x: auto on the card so the table can scroll horizontally
          when the window is narrower than the sum of column widths (~1100px
          minimum). The min-width on the table prevents columns from being
          squished into illegible widths — they keep their declared sizes
          and a horizontal scrollbar appears at the bottom of the card.
        */}
        <div className="card-surface" style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked;
                    }}
                    onChange={toggleAll}
                  />
                </th>
                <th style={{ width: 86 }}>{t('dashboard.col.pj')}</th>
                <th style={{ width: 96, whiteSpace: 'nowrap' }}>{t('dashboard.col.date')}</th>
                <th style={{ width: 110 }}>{t('dashboard.col.num')}</th>
                <th>{t('dashboard.col.vendor')}</th>
                <th style={{ width: 120 }}>{t('dashboard.col.entity')}</th>
                <th style={{ textAlign: 'right', width: 110 }}>{t('dashboard.col.amount')}</th>
                <th style={{ width: 90 }}>{t('dashboard.col.building')}</th>
                <th style={{ width: 110 }}>{t('dashboard.col.sheet')}</th>
                <th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((it) =>
                it.kind === 'single' ? (
                  <Row
                    key={it.row.id}
                    row={it.row}
                    selected={selection.has(it.row.id)}
                    onToggle={() => toggleRow(it.row.id)}
                    foreign={!rowIsMine(it.row.bookingEntity)}
                    destinationLabel={
                      company
                        ? rowDestinationLabel(it.row.bookingEntity, company, companies)
                        : undefined
                    }
                  />
                ) : (
                  <GroupRows
                    key={it.id}
                    members={it.members}
                    total={it.total}
                    expanded={expandedGroups.has(it.id)}
                    onToggleExpanded={() => toggleGroupExpanded(it.id)}
                    selection={selection}
                    onToggleMember={toggleRow}
                    onToggleAllMembers={() =>
                      toggleGroupSelection(it.members.map((m) => m.id))
                    }
                    foreign={!rowIsMine(it.members[0].bookingEntity)}
                    destinationLabel={
                      company
                        ? rowDestinationLabel(it.members[0].bookingEntity, company, companies)
                        : undefined
                    }
                  />
                ),
              )}
              {items.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                    {loading ? t('dashboard.loading') : t('dashboard.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div
        style={{
          padding: '8px 20px',
          borderTop: '1px solid var(--line)',
          background: 'var(--paper-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11.5,
          color: 'var(--muted)',
          flexShrink: 0,
        }}
      >
        <span title={lastSync ? new Date(lastSync).toLocaleString('fr-CA') : undefined}>
          {t('dashboard.synced')} {relativeTime(lastSync)}
        </span>
        <span>·</span>
        <span className="mono">
          {sourceLabel}
          {sheetsCount > 0
            ? ` · ${sheetsCount} ${t('dashboard.col.sheet').toLowerCase()}${sheetsCount > 1 ? 's' : ''}`
            : ''}
        </span>
        <span style={{ flex: 1 }} />
        <span>
          <span className="kbd">⌘A</span> {t('dashboard.kbd_select_all')}
        </span>
        <span>
          <span className="kbd">↵</span> {t('dashboard.kbd_launch')}
        </span>
      </div>

      {/*
        Floating launch FAB — appears once the inline button scrolls out of
        view. We always render the wrapper with a fade transition so React
        can animate the in/out smoothly instead of mounting/unmounting.
        pointer-events: none when invisible so it doesn't catch clicks.
      */}
      <div
        style={{
          position: 'absolute',
          bottom: 56,
          right: 24,
          zIndex: 30,
          opacity: launchOffscreen && selection.size > 0 ? 1 : 0,
          transform:
            launchOffscreen && selection.size > 0
              ? 'translateY(0)'
              : 'translateY(12px)',
          transition: 'opacity 180ms ease, transform 180ms ease',
          pointerEvents: launchOffscreen && selection.size > 0 ? 'auto' : 'none',
        }}
      >
        <button
          className="btn btn-primary"
          onClick={launch}
          disabled={selection.size === 0 || !company?.connected}
          style={{
            padding: '10px 18px',
            fontSize: 13,
            boxShadow:
              '0 12px 28px rgba(46,77,57,0.32), 0 4px 8px rgba(0,0,0,0.12)',
            borderRadius: 999,
          }}
          title={
            selection.size > 0
              ? `~${selection.size * 8} requêtes estimées (limite QBO 500/min)`
              : t('dashboard.launch')
          }
        >
          <Icon name="play" size={13} /> {t('dashboard.launch')} ({selection.size}
          {selection.size > 0 ? ` · ~${selection.size * 8} req` : ''})
        </button>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  highlight,
  title,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  title?: string;
}) {
  return (
    <div className="card-surface" style={{ padding: '12px 14px' }} title={title}>
      <div className="kv">
        <span className="k">{label}</span>
        <span
          className="v"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: highlight ? 'var(--warn)' : 'var(--ink)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`chip ${active ? 'chip-accent' : ''}`}
      style={{ cursor: 'pointer', padding: '4px 10px' }}
    >
      {label}
    </button>
  );
}

function Row({
  row,
  selected,
  onToggle,
  foreign,
  destinationLabel,
}: {
  row: BudgetRow;
  selected: boolean;
  onToggle: () => void;
  foreign?: boolean;
  // Label of the company whose QBO realm will receive this row's
  // search query — overrides the chip text so external suppliers
  // (Hydro / SATCOM / L2V4) and unconnected sisters (VSL) all show
  // the active company's name instead of their bookingEntity.
  destinationLabel?: string;
}) {
  const [commentExpanded, setCommentExpanded] = useState(false);
  return (
    <tr
      className={`${rowNeedsAction(row) ? 'missing-pj' : ''}${selected ? ' selected' : ''}`}
      style={foreign ? { opacity: 0.55 } : undefined}
      title={foreign ? t('dashboard.entity_scope.row_foreign') : undefined}
    >
      <td>
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td>
        <PjStatusCell row={row} />
      </td>
      <td className="mono" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 11.5 }}>
        {row.date}
      </td>
      <td className="mono" style={{ fontWeight: 500 }}>
        {row.docNumber}
      </td>
      <td>
        <div>{row.vendor}</div>
        {row.rawVendor && row.rawVendor !== row.vendor && (
          <div
            title={`${t('review.brut_prefix')}: ${row.rawVendor}`}
            style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 1, fontStyle: 'italic' }}
          >
            {t('review.brut_prefix')} : {row.rawVendor}
          </div>
        )}
        {row.comment && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              setCommentExpanded((v) => !v);
            }}
            title={commentExpanded ? t('dashboard.comment.collapse') : row.comment}
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              marginTop: 2,
              cursor: 'pointer',
              ...(commentExpanded
                ? {
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    maxWidth: 460,
                    background: 'var(--paper-2)',
                    borderRadius: 4,
                    padding: '4px 6px',
                    margin: '4px 0',
                  }
                : {
                    maxWidth: 360,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }),
            }}
          >
            {row.comment}
          </div>
        )}
      </td>
      <td style={{ fontSize: 11.5 }}>
        {(destinationLabel || row.bookingEntity) ? (
          <span
            className={`chip ${foreign ? 'chip-warn' : ''}`}
            style={{ fontSize: 10.5 }}
            // Tooltip preserves the raw budget value when we override the
            // chip text — the user can hover to see "Hydro-Québec" etc.
            title={
              foreign
                ? t('dashboard.entity_scope.row_foreign')
                : destinationLabel && row.bookingEntity && destinationLabel !== row.bookingEntity
                  ? `brut : ${row.bookingEntity}`
                  : undefined
            }
          >
            {destinationLabel ?? row.bookingEntity}
          </span>
        ) : (
          <span style={{ color: 'var(--muted-2)' }}>—</span>
        )}
      </td>
      <td
        className="mono"
        style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        {fmtCurrency(row.amount)}
      </td>
      <td>
        {row.building ? (
          <BuildingChip name={row.building} />
        ) : (
          <span style={{ color: 'var(--muted-2)' }}>—</span>
        )}
      </td>
      <td style={{ color: 'var(--muted)', fontSize: 11.5 }}>{row.sheet}</td>
      <td>
        <button
          className="btn btn-ghost btn-sm btn-icon"
          title={t('dashboard.search_qbo_row')}
          onClick={(e) => {
            e.stopPropagation();
            const url = `https://qbo.intuit.com/app/globalsearch?searchstring=${encodeURIComponent(row.docNumber)}`;
            window.qboApi.openUrl(url);
          }}
        >
          <Icon name="external" size={12} />
        </button>
      </td>
    </tr>
  );
}

function GroupRows({
  members,
  total,
  expanded,
  onToggleExpanded,
  selection,
  onToggleMember,
  onToggleAllMembers,
  foreign,
  destinationLabel,
}: {
  members: BudgetRow[];
  total: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  selection: Set<string>;
  onToggleMember: (id: string) => void;
  onToggleAllMembers: () => void;
  foreign?: boolean;
  destinationLabel?: string;
}) {
  const head = members[0];
  const allSelected = members.every((m) => selection.has(m.id));
  const someSelected = !allSelected && members.some((m) => selection.has(m.id));
  const [commentExpanded, setCommentExpanded] = useState(false);

  return (
    <>
      <tr
        className={`${rowNeedsAction(head) ? 'missing-pj' : ''}${allSelected ? ' selected' : ''}`}
        style={foreign ? { opacity: 0.55 } : undefined}
        title={foreign ? t('dashboard.entity_scope.row_foreign') : undefined}
      >
        <td>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={onToggleAllMembers}
          />
        </td>
        <td>
          <PjStatusCell row={head} />
        </td>
        <td className="mono" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 11.5 }}>
          {head.date}
        </td>
        <td>
          <button
            onClick={onToggleExpanded}
            className="btn btn-ghost"
            style={{
              padding: '2px 6px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              fontWeight: 500,
            }}
            title={expanded ? t('dashboard.collapse') : t('dashboard.expand')}
          >
            <Icon name={expanded ? 'chev-down' : 'chev-right'} size={11} />
            {members.length} {t('dashboard.invoices_count')}
          </button>
        </td>
        <td>
          <div>{head.vendor}</div>
          {head.rawVendor && head.rawVendor !== head.vendor && (
            <div
              title={`${t('review.brut_prefix')}: ${head.rawVendor}`}
              style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 1, fontStyle: 'italic' }}
            >
              {t('review.brut_prefix')} : {head.rawVendor}
            </div>
          )}
          {head.comment && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setCommentExpanded((v) => !v);
              }}
              title={commentExpanded ? t('dashboard.comment.collapse') : head.comment}
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
                cursor: 'pointer',
                ...(commentExpanded
                  ? {
                      whiteSpace: 'normal',
                      wordBreak: 'break-word',
                      maxWidth: 460,
                      background: 'var(--paper-2)',
                      borderRadius: 4,
                      padding: '4px 6px',
                      margin: '4px 0',
                    }
                  : {
                      maxWidth: 360,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }),
              }}
            >
              {head.comment}
            </div>
          )}
        </td>
        <td style={{ fontSize: 11.5 }}>
          {(destinationLabel || head.bookingEntity) ? (
            <span
              className={`chip ${foreign ? 'chip-warn' : ''}`}
              style={{ fontSize: 10.5 }}
              title={
                foreign
                  ? t('dashboard.entity_scope.row_foreign')
                  : destinationLabel && head.bookingEntity && destinationLabel !== head.bookingEntity
                    ? `brut : ${head.bookingEntity}`
                    : undefined
              }
            >
              {destinationLabel ?? head.bookingEntity}
            </span>
          ) : (
            <span style={{ color: 'var(--muted-2)' }}>—</span>
          )}
        </td>
        <td className="mono" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCurrency(total)}
        </td>
        <td>
          {head.building ? (
            <BuildingChip name={head.building} />
          ) : (
            <span style={{ color: 'var(--muted-2)' }}>—</span>
          )}
        </td>
        <td style={{ color: 'var(--muted)', fontSize: 11.5 }}>{head.sheet}</td>
        <td>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            title={t('dashboard.search_qbo_group')}
            onClick={(e) => {
              e.stopPropagation();
              const url = `https://qbo.intuit.com/app/globalsearch?searchstring=${encodeURIComponent(head.vendor)}`;
              window.qboApi.openUrl(url);
            }}
          >
            <Icon name="external" size={12} />
          </button>
        </td>
      </tr>
      {expanded &&
        members.map((m) => (
          <tr
            key={m.id}
            className={`${rowNeedsAction(m) ? 'missing-pj' : ''}${selection.has(m.id) ? ' selected' : ''}`}
          >
            <td>
              <input
                type="checkbox"
                checked={selection.has(m.id)}
                onChange={() => onToggleMember(m.id)}
              />
            </td>
            <td />
            <td />
            <td
              className="mono"
              style={{
                fontWeight: 500,
                paddingLeft: 28,
                borderLeft: '2px solid var(--line-2)',
              }}
            >
              {m.docNumber}
            </td>
            <td style={{ color: 'var(--muted)', fontSize: 12 }}>
              {m.vendor !== head.vendor ? m.vendor : '—'}
            </td>
            <td />
            <td
              className="mono"
              style={{ textAlign: 'right', color: 'var(--muted-2)', fontSize: 12 }}
            >
              —
            </td>
            <td />
            <td />
            <td />
          </tr>
        ))}
    </>
  );
}

// Discrete, accessible palette — pale background + dark ink. Mapped
// deterministically by hashing the building name so "1310" always lands on
// the same swatch and the eye can group rows at a glance without reading.
const BUILDING_PALETTE: { bg: string; fg: string; border: string }[] = [
  { bg: '#e6ede7', fg: '#1f3a29', border: '#cfdbd2' }, // forêt
  { bg: '#f6ecd7', fg: '#6b4710', border: '#ead9b4' }, // ambre
  { bg: '#e6eaf0', fg: '#2a3a52', border: '#d2d9e3' }, // bleu ardoise
  { bg: '#f3dede', fg: '#6d1e1e', border: '#e4c3c3' }, // brique
  { bg: '#ebe4ee', fg: '#3d2752', border: '#d8cfdf' }, // prune
  { bg: '#e2ece9', fg: '#1c4640', border: '#c7d8d3' }, // sarcelle
  { bg: '#f0e8de', fg: '#574021', border: '#dcd0bd' }, // sable
  { bg: '#e7eee2', fg: '#33491f', border: '#ccd9c2' }, // olive
];

function buildingColor(name: string): { bg: string; fg: string; border: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return BUILDING_PALETTE[h % BUILDING_PALETTE.length];
}

function BuildingChip({ name }: { name: string }) {
  const c = buildingColor(name);
  return (
    <span
      className="chip"
      style={{
        background: c.bg,
        color: c.fg,
        borderColor: c.border,
        fontVariantNumeric: 'tabular-nums',
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
      }}
    >
      {name}
    </span>
  );
}

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return 'à l\u2019instant';
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'à l\u2019instant';
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `il y a ${d} j`;
  return new Date(ts).toLocaleDateString('fr-CA');
}

// True when a row still requires the user's attention — drives the
// "missing-pj" row tint. A row already flagged in the budget OR
// successfully extracted via QBO is considered done; ambiguous, not-
// found, and no-PJ rows still need work and stay tinted.
function rowNeedsAction(row: BudgetRow): boolean {
  if (row.hasAttachment) return false;
  if (row.extractionStatus === 'ok') return false;
  if (row.extractionStatus === 'nopj') return false; // QBO confirmed no PJ — closed loop
  return true;
}

// PJ status cell — combines two signals into a single visual:
//   1. The budget's own "PJ" column (hasAttachment) — true when the
//      spreadsheet already says "Oui", meaning the user filed the PJ
//      themselves and the extractor has nothing to do.
//   2. The persisted extraction history (run_rows joined to runs +
//      companies for this project). When the spreadsheet doesn't
//      flag the row, but a previous run successfully fetched the PJ
//      from QBO, we want to show that — otherwise the user re-runs
//      the same row tomorrow.
//
// Priority: hasAttachment wins (the spreadsheet is the source of
// truth for "this row has its file"). When that's false, the
// extraction history surfaces.
function PjStatusCell({ row }: { row: BudgetRow }) {
  if (row.hasAttachment) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
        <span className="dot dot-ok" />
        <span style={{ fontSize: 11.5 }}>OK</span>
      </span>
    );
  }
  const tooltipDate = row.extractedAt
    ? new Date(row.extractedAt).toLocaleString('fr-CA')
    : null;
  switch (row.extractionStatus) {
    case 'ok':
      return (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}
          title={
            tooltipDate ? `Extraite via QBO le ${tooltipDate}` : 'Extraite via QBO'
          }
        >
          <span className="dot dot-ok" />
          <span style={{ fontSize: 11.5 }}>Extraite</span>
        </span>
      );
    case 'amb':
      return (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#a86620' }}
          title="Plusieurs candidats QBO — à résoudre depuis l'écran Review"
        >
          <span className="dot" style={{ background: '#e0a155' }} />
          <span style={{ fontSize: 11.5 }}>Ambigu</span>
        </span>
      );
    case 'nf':
      return (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--err)' }}
          title="Aucun match QBO lors du dernier run"
        >
          <span className="dot" style={{ background: 'var(--err)' }} />
          <span style={{ fontSize: 11.5 }}>Introuvable</span>
        </span>
      );
    case 'nopj':
      return (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#8a6d2c' }}
          title="Transaction QBO trouvée mais sans pièce jointe"
        >
          <span className="dot" style={{ background: '#d8b257' }} />
          <span style={{ fontSize: 11.5 }}>Sans PJ</span>
        </span>
      );
    default:
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--warn)' }}>
          <span className="dot dot-warn" />
          <span style={{ fontSize: 11.5 }}>{t('status.missing')}</span>
        </span>
      );
  }
}
