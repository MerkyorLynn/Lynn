import { Component, type ReactNode } from 'react';
import styles from './RegionalErrorBoundary.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

function tr(key: string, fallback: string): string {
  try {
    const translated = window.t?.(key);
    if (translated && translated !== key) return String(translated);
  } catch {
    // Fall through to the declared global translator.
  }
  try {
    const translated = t(key);
    if (translated && translated !== key) return String(translated);
  } catch {
    // Fall through to the provided fallback text.
  }
  return fallback;
}

interface Props {
  region: string;
  resetKeys?: unknown[];
  children: ReactNode;
}

interface State {
  error: Error | null;
  prevResetKeys: unknown[];
}

export class RegionalErrorBoundary extends Component<Props, State> {
  state: State = { error: null, prevResetKeys: this.props.resetKeys || [] };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKeys && state.error) {
      const changed = props.resetKeys.some((k, i) => k !== state.prevResetKeys[i]);
      if (changed) return { error: null, prevResetKeys: props.resetKeys };
    }
    if (props.resetKeys) return { prevResetKeys: props.resetKeys };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Import dynamically to avoid circular deps and TS issues with JS imports
    // @ts-expect-error -- shared JS module, no type declarations
    import('../../../../shared/error-bus.js').then(({ errorBus }: { errorBus: { report: (e: unknown, opts?: unknown) => void } }) => {
      // @ts-expect-error -- shared JS module, no type declarations
      import('../../../../shared/errors.js').then(({ AppError }: { AppError: new (code: string, opts?: Record<string, unknown>) => Error }) => {
        errorBus.report(new AppError('RENDER_CRASH', {
          cause: error,
          context: { region: this.props.region, componentStack: info.componentStack?.slice(0, 500) },
        }));
      });
    }).catch(() => { /* best effort - error reporting itself failed */ });
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.fallback}>
          <p className={styles.message}>{tr('error.regionUnavailable', '这个区域暂时不可用')}</p>
          <button className={styles.retry} onClick={this.handleRetry}>
            {tr('action.retry', '重试')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
