import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';

// Check the public GitHub Releases API for a newer tag than the
// bundled app.getVersion(). When found, surface a non-blocking
// banner at the top of the window with a one-click jump to the
// release page (DMG download). Click "Plus tard" to dismiss the
// notification *for that specific version* — we won't pester the
// user again until the next release lands.
//
// Constraints driving the design:
//   - No paid Apple Dev cert → we can't auto-replace the bundle.
//     Best we can do is route the user to the DMG fast.
//   - GitHub anonymous API rate limit is 60 requests / hour / IP.
//     We poll once on mount + every hour while the app is open;
//     well below the cap even with multiple tabs.
//   - Public repo so /releases/latest is unauthenticated.
const REPO = 'Othoiko974/qbo-extractor';
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DISMISS_KEY = 'qbo_dismissed_update_version';

type LatestRelease = {
  version: string; // tag stripped of leading 'v'
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
    if (!current) return;
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(
          `https://api.github.com/repos/${REPO}/releases/latest`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!r.ok) return;
        const data = (await r.json()) as {
          tag_name?: string;
          html_url?: string;
          published_at?: string;
        };
        const tag = (data.tag_name ?? '').replace(/^v/, '');
        if (!tag) return;
        if (cancelled) return;
        if (semverGt(tag, current)) {
          setLatest({
            version: tag,
            url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
            publishedAt: data.published_at ?? '',
          });
        }
      } catch {
        // Offline / API down / GitHub rate-limited — silent skip.
        // The user will get the banner the next time the check runs.
      }
    };
    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [current]);

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
        Nouvelle version <b>v{latest.version}</b> disponible (tu utilises v{current}).
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

// Tiny semver compare — splits into numeric segments and compares
// element-wise. Pre-release suffixes (`-rc1`, `-beta.2`) are ignored
// so a stable v0.2.0 doesn't trigger an upgrade prompt for someone
// running v0.2.0-rc1; we treat them as equivalent. Returns true iff
// `a` is strictly greater than `b`.
function semverGt(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((s) => parseInt(s, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
