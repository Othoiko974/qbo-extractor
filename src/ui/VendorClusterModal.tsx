import React, { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { Icon } from './Icon';
import type { VendorCluster } from '../types/domain';

// Shown after resyncBudget() returns with unresolved vendor clusters. Each
// cluster is a group of raw names the fuzzy matcher thinks are spellings of
// the same merchant. The user picks (or types) a canonical name, and the
// accepted clusters are written to vendor_aliases as raw→canonical rows.
export function VendorClusterModal() {
  const { pendingClusters, dismissClusters, confirmClusters } = useStore();
  const open = pendingClusters.length > 0;
  if (!open) return null;
  return <Modal clusters={pendingClusters} onDismiss={dismissClusters} onConfirm={confirmClusters} />;
}

type Decision = {
  canonical: string;
  accepted: Set<string>;
};

function Modal({
  clusters,
  onDismiss,
  onConfirm,
}: {
  clusters: VendorCluster[];
  onDismiss: () => void;
  onConfirm: (entries: { rawName: string; canonicalName: string }[]) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<number, Decision>>(() => {
    const init: Record<number, Decision> = {};
    clusters.forEach((c, i) => {
      init[i] = {
        canonical: c.canonical,
        accepted: new Set([c.canonical, ...c.aliases]),
      };
    });
    return init;
  });
  const [saving, setSaving] = useState(false);

  const toggleMember = (idx: number, name: string) => {
    setDecisions((prev) => {
      const d = prev[idx];
      const next = new Set(d.accepted);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...prev, [idx]: { ...d, accepted: next } };
    });
  };

  const setCanonical = (idx: number, value: string) => {
    setDecisions((prev) => ({ ...prev, [idx]: { ...prev[idx], canonical: value } }));
  };

  const totalAccepted = useMemo(() => {
    let n = 0;
    for (const d of Object.values(decisions)) n += d.accepted.size;
    return n;
  }, [decisions]);

  const save = async () => {
    const entries: { rawName: string; canonicalName: string }[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const d = decisions[i];
      const canonical = d.canonical.trim();
      if (!canonical) continue;
      for (const raw of d.accepted) entries.push({ rawName: raw, canonicalName: canonical });
    }
    setSaving(true);
    await onConfirm(entries);
    setSaving(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="card-surface"
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--paper)',
          boxShadow: '0 20px 60px rgba(0,0,0,.25)',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              Normalisation des noms de fournisseurs
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {clusters.length} groupe{clusters.length > 1 ? 's' : ''} de noms similaires détecté{clusters.length > 1 ? 's' : ''}.
              Choisis le nom canonique et décoche les alias qui ne sont pas le même fournisseur.
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onDismiss} disabled={saving} title="Ignorer">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {clusters.map((cluster, idx) => {
            const d = decisions[idx];
            const members = [cluster.canonical, ...cluster.aliases];
            return (
              <div
                key={idx}
                className="card-surface"
                style={{ padding: 12, marginBottom: 10, background: 'var(--paper-2)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span
                    className="muted"
                    style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}
                  >
                    Nom canonique
                  </span>
                  <input
                    className="input input-sm"
                    value={d.canonical}
                    onChange={(e) => setCanonical(idx, e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <span className="chip" style={{ fontSize: 10.5 }}>
                    score {Math.round(cluster.score * 100)}%
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {members.map((name) => {
                    const on = d.accepted.has(name);
                    return (
                      <button
                        key={name}
                        onClick={() => toggleMember(idx, name)}
                        className={`chip ${on ? 'chip-accent' : ''}`}
                        style={{
                          cursor: 'pointer',
                          padding: '4px 9px',
                          fontSize: 11.5,
                          opacity: on ? 1 : 0.55,
                          textDecoration: on ? 'none' : 'line-through',
                        }}
                        title={on ? 'Cliquer pour exclure' : 'Cliquer pour inclure'}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {clusters.length === 0 && (
            <div className="muted" style={{ textAlign: 'center', padding: 40 }}>
              Aucun cluster à confirmer.
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            <b style={{ color: 'var(--ink)' }}>{totalAccepted}</b> alias seront enregistrés
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-ghost" onClick={onDismiss} disabled={saving}>
            Plus tard
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? 'Enregistrement…' : 'Confirmer'}
          </button>
        </div>
      </div>
    </div>
  );
}
