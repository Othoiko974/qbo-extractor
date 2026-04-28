import React from 'react';

// React error boundary — if any child throws during render or lifecycle,
// we catch the error and show a readable diagnostic instead of the
// renderer dying silently with a white screen. The fallback also exposes
// a "Recharger" button so the user can retry without quitting the app.

type Props = { children: React.ReactNode };
type State = { error: Error | null; info: React.ErrorInfo | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Mirror the crash to the main process log so we can grep it later.
    // eslint-disable-next-line no-console
    console.error('[renderer:crash]', error, info);
    this.setState({ error, info });
  }

  reload = () => {
    location.reload();
  };

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          padding: 32,
          fontFamily: 'var(--mono)',
          color: '#1a1814',
          background: '#faf8f3',
          minHeight: '100vh',
          overflow: 'auto',
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
            Erreur d'interface
          </h1>
          <p style={{ fontSize: 13, color: '#6b6760', marginBottom: 16 }}>
            Le rendu a planté. Voici la trace pour pouvoir débugger — copie-la
            si tu veux la partager.
          </p>
          <pre
            style={{
              fontSize: 12,
              background: '#fff',
              border: '1px solid #e6e1d5',
              borderRadius: 8,
              padding: 14,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              marginBottom: 16,
              maxHeight: '50vh',
              overflow: 'auto',
            }}
          >
            <strong>{error.name}: {error.message}</strong>
            {'\n\n'}
            {error.stack ?? '(no stack)'}
            {info?.componentStack ? `\n\n--- componentStack ---${info.componentStack}` : ''}
          </pre>
          <button
            type="button"
            onClick={this.reload}
            style={{
              padding: '8px 14px',
              background: '#2e4d39',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          >
            Recharger l'app
          </button>
        </div>
      </div>
    );
  }
}
