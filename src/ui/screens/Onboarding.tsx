import React from 'react';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';

const STEPS: [string, string, string][] = [
  ['1', 'onboarding.step1.title', 'onboarding.step1.desc'],
  ['2', 'onboarding.step2.title', 'onboarding.step2.desc'],
  ['3', 'onboarding.step3.title', 'onboarding.step3.desc'],
];

export function Onboarding({ onStart }: { onStart: () => void }) {
  useLang();
  return (
    <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 520, textAlign: 'center', padding: 40, margin: 'auto' }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 14,
            background: 'var(--accent)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--mono)',
            fontWeight: 700,
            fontSize: 22,
            margin: '0 auto 18px',
            boxShadow: '0 8px 24px rgba(46,77,57,.22)',
          }}
        >
          QBO
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {t('onboarding.title')}
        </h1>
        <p className="muted" style={{ margin: '0 0 28px', fontSize: 14, lineHeight: 1.5 }}>
          {t('onboarding.subtitle')}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 28 }}>
          {STEPS.map(([n, h, p]) => (
            <div key={n} className="card-surface" style={{ padding: 14, textAlign: 'left' }}>
              <div className="tag-letter mono" style={{ marginBottom: 10 }}>{n}</div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{t(h)}</div>
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{t(p)}</div>
            </div>
          ))}
        </div>

        <button onClick={onStart} className="btn btn-primary" style={{ padding: '10px 20px', fontSize: 13.5 }}>
          <Icon name="plus" size={14} /> {t('onboarding.start')}
        </button>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 16 }}>
          {t('onboarding.local_data')}
        </div>
      </div>
    </div>
  );
}
