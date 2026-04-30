import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store';

// Modal that fires when startExtraction returns busy:true. Polls the
// proxy every 10 s; when the lock frees we automatically retry the run
// the user originally tried to launch. The "Annuler" path drops the
// pending selection.

type LockStatus =
  | { busy: false }
  | {
      busy: true;
      is_self: boolean;
      api_key_label: string;
      total_rows: number;
      estimated_requests: number;
      started_at: number;
      last_heartbeat: number;
      eta_seconds: number;
    }
  | { error: string };

function fmtSec(s: number): string {
  if (s < 60) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}
function fmtElapsed(startedAt: number): string {
  return fmtSec(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
}

export function BusyLockModal(): React.ReactElement | null {
  const { busyLock, dismissBusyLock, retryBusyLock, activeCompanyKey } = useStore();
  const [polling, setPolling] = useState(false);
  const [polledEta, setPolledEta] = useState<number | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);

  useEffect(() => {
    if (!busyLock || !activeCompanyKey) return;
    let cancelled = false;
    setPolling(true);
    setPollErr(null);

    const tick = async () => {
      if (cancelled) return;
      try {
        const status = (await window.qboApi.extractionLockStatus(activeCompanyKey)) as LockStatus;
        if (cancelled) return;
        if ('error' in status) {
          setPollErr(status.error);
          return;
        }
        if (!status.busy) {
          // Lock just freed — auto-retry the original selection.
          setPolling(false);
          await retryBusyLock();
          return;
        }
        setPolledEta(status.eta_seconds);
      } catch (e) {
        if (!cancelled) setPollErr((e as Error).message);
      }
    };

    void tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busyLock?.api_key_label, busyLock?.started_at, activeCompanyKey, retryBusyLock]);

  if (!busyLock) return null;

  const eta = polledEta ?? busyLock.eta_seconds;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          color: 'var(--fg, #1a1a1a)',
          border: '1px solid var(--border, #e5e5e0)',
          borderRadius: 12,
          padding: 28,
          maxWidth: 460,
          width: '92%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 18, color: 'var(--accent, #2e4d39)' }}>
          Un autre poste est en cours d'extraction
        </h2>
        <p style={{ fontSize: 13, color: 'var(--muted, #666)', margin: '0 0 16px', lineHeight: 1.5 }}>
          QuickBooks limite à 500 requêtes par minute pour cette compagnie. Pour ne pas exploser
          la limite, une seule extraction tourne à la fois.
        </p>
        <div
          style={{
            background: 'var(--code-bg, #f0f0ea)',
            padding: 14,
            borderRadius: 8,
            fontSize: 13,
            lineHeight: 1.6,
            margin: '0 0 16px',
          }}
        >
          <div>
            <strong>{busyLock.api_key_label}</strong>
          </div>
          <div>
            {busyLock.total_rows} lignes (~{busyLock.estimated_requests} req)
          </div>
          <div style={{ color: 'var(--muted, #666)' }}>
            Démarré il y a {fmtElapsed(busyLock.started_at)}
            {eta > 0 && ` · ETA ~${fmtSec(eta)}`}
          </div>
        </div>
        {polling && (
          <div style={{ fontSize: 12, color: 'var(--muted, #666)', marginBottom: 12 }}>
            Vérification automatique toutes les 10 s — le run reprendra dès que le lock se libère.
          </div>
        )}
        {pollErr && (
          <div style={{ fontSize: 12, color: 'var(--err, #b00020)', marginBottom: 12 }}>
            {pollErr}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn btn-ghost"
            onClick={dismissBusyLock}
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}
