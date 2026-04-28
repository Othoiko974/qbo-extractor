import React, { useEffect, useMemo, useState } from 'react';
import { useShortcutRegistry, type KeyBinding } from './useKeyboardShortcuts';
import { t, useLang } from '../i18n';

const HOLD_DURATION_MS = 400;

// macOS-style "hold ⌘" affordance. Press and keep ⌘ down (alone) for ~400ms
// and an HUD slides in listing every keyboard shortcut the active screen
// publishes. Release ⌘ to dismiss. Pressing any other key while holding
// cancels the timer (we don't want the overlay to flash when the user is
// composing a chord like ⌘A).

export function ShortcutOverlay() {
  useLang();
  const bindings = useShortcutRegistry();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let metaDown = false;

    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') {
        if (metaDown) return; // browser auto-repeat — ignore
        metaDown = true;
        cancel();
        timer = setTimeout(() => {
          setVisible(true);
          timer = null;
        }, HOLD_DURATION_MS);
        return;
      }
      // Any other key while ⌘ is being held → user is doing a chord, not
      // asking for the cheat-sheet. Cancel the timer and (if we already
      // showed the overlay) hide it.
      cancel();
      if (visible) setVisible(false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') {
        metaDown = false;
        cancel();
        setVisible(false);
      }
    };

    // Belt and suspenders: if the window loses focus while ⌘ is held, the
    // browser sometimes never delivers a keyup. Treat blur as release.
    const onBlur = () => {
      metaDown = false;
      cancel();
      setVisible(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      cancel();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [visible]);

  // Group bindings for the overlay; bindings without a label are hidden.
  const grouped = useMemo(() => {
    const map = new Map<string, KeyBinding[]>();
    for (const b of bindings) {
      if (!b.label) continue;
      const g = b.group ?? t('shortcuts.group.default');
      const arr = map.get(g) ?? [];
      arr.push(b);
      map.set(g, arr);
    }
    return Array.from(map.entries());
  }, [bindings]);

  if (!visible) return null;

  const totalLabelled = grouped.reduce((n, [, list]) => n + list.length, 0);
  if (totalLabelled === 0) return null;

  return (
    <div
      role="dialog"
      aria-label={t('shortcuts.title')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(20, 18, 14, 0.32)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        animation: 'qbo-overlay-fade 140ms ease-out',
        pointerEvents: 'none', // never block clicks underneath
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '92%',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: 'rgba(34, 31, 26, 0.94)',
          color: '#f5f1e6',
          borderRadius: 14,
          padding: '20px 24px',
          boxShadow: '0 24px 56px rgba(0, 0, 0, 0.45)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          fontSize: 12.5,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('shortcuts.title')}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: 'rgba(245, 241, 230, 0.55)',
              fontFamily: 'var(--mono)',
              letterSpacing: '0.04em',
            }}
          >
            {t('shortcuts.release_hint')}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {grouped.map(([group, list]) => (
            <div key={group}>
              <div
                style={{
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'rgba(245, 241, 230, 0.5)',
                  marginBottom: 8,
                  fontWeight: 600,
                }}
              >
                {group}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.map((b, i) => (
                  <div
                    key={`${b.key}-${i}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                    }}
                  >
                    <div style={{ color: 'rgba(245, 241, 230, 0.92)' }}>
                      {b.label}
                    </div>
                    <KeyCombo binding={b} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes qbo-overlay-fade {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

function KeyCombo({ binding }: { binding: KeyBinding }) {
  const parts: string[] = [];
  if (binding.meta) parts.push('⌘');
  if (binding.alt) parts.push('⌥');
  if (binding.shift) parts.push('⇧');
  parts.push(prettyKey(binding.key));
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 22,
            height: 22,
            padding: '0 6px',
            borderRadius: 5,
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: '#f5f1e6',
            fontWeight: 500,
          }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}

function prettyKey(k: string): string {
  switch (k) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Enter':
      return '↵';
    case 'Escape':
      return 'Esc';
    case ' ':
      return 'Space';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    default:
      return k.length === 1 ? k.toUpperCase() : k;
  }
}
