import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';

// Surface a non-blocking banner at the top of the window when a newer
// release exists on GitHub. Click "Télécharger" routes to the release
// page (DMG download); "Plus tard" stashes the seen version in
// localStorage so we don't pester for the same release.
//
// The actual GitHub fetch + version compare runs in the main process
// (see ipc.ts → 'app:checkForUpdate') because the renderer's CSP
// only allows connections to *.intuit.com and *.googleapis.com — we
// don't want to widen it for one API hit. Main has no CSP so it can
// hit api.github.com freely.
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DISMISS_KEY = 'qbo_dismissed_update_version';

type LatestRelease = {
  version: string;
  url: string;
  publishedAt: string;
};

export function UpdateBanner() {
  const [current, setCurrent] = useState<string | null>(null);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    void window.qboApi.appVersion().then(setCurrent);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const res = await window.qboApi.checkForUpdate();
      if (cancelled) return;
      if (res.latest) setLatest(res.latest);
    };
    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!latest) return null;
  if (dismissed === latest.version) return null;

  const download = () => {
    void window.qboApi.openUrl(latest.url);
  };
  const later = () => {
    try {
      localStorage.setItem(DISMISS_KEY, latest.version);
    } catch {
      /* private mode — fall through silently */
    }
    setDismissed(latest.version);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        background: '#eaf3ff',
        borderBottom: '1px solid #c7dbf5',
        color: '#1d3557',
        fontSize: 12,
      }}
    >
      <Icon name="download" size={12} />
      <span style={{ flex: 1 }}>
        Nouvelle version <b>v{latest.version}</b> disponible
        {current && ` (tu utilises v${current})`}.
      </span>
      <button
        className="btn btn-sm btn-primary"
        onClick={download}
        style={{ padding: '2px 10px' }}
      >
        Télécharger
      </button>
      <button
        className="btn btn-sm btn-ghost"
        onClick={later}
        style={{ padding: '2px 8px' }}
      >
        Plus tard
      </button>
    </div>
  );
}
