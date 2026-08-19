import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so a component crash shows a recoverable message
 * instead of a blank webview panel.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaces in the webview devtools console (Developer: Open Webview Developer Tools).
    console.error('Webview render error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)', color: 'var(--vscode-foreground)' }}>
        <h3 style={{ marginTop: 0 }}>The pipeline view hit an error</h3>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            background: 'var(--vscode-textBlockQuote-background)',
            padding: 12,
            borderRadius: 4,
          }}
        >
          {error.message}
        </pre>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
