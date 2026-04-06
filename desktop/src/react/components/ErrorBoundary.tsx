import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 可选的回退 UI 区域名称，用于错误提示 */
  region?: string;
}

interface State {
  error: Error | null;
  errorType: 'render' | 'network' | 'unknown';
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorType: 'unknown' };

  static getDerivedStateFromError(error: Error): State {
    // 区分错误类型
    const msg = error.message?.toLowerCase() || '';
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('abort') || msg.includes('timeout')) {
      return { error, errorType: 'network' };
    }
    return { error, errorType: 'render' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    window.__hanaLog?.('error', 'react', `${error.message}\n${info.componentStack}`);
  }

  handleRetry = () => {
    this.setState({ error: null, errorType: 'unknown' });
  };

  render() {
    if (this.state.error) {
      const { errorType } = this.state;
      const region = this.props.region;
      const isZh = String(document?.documentElement?.lang || '').startsWith('zh');

      const title = errorType === 'network'
        ? (isZh ? '连接出了点问题' : 'Connection issue')
        : (isZh ? '这里暂时出了点问题' : 'Something went wrong');

      const hint = errorType === 'network'
        ? (isZh ? '检查一下连接后再试一次。' : 'Check your connection and try again.')
        : region
          ? (isZh ? `${region} 区域发生了异常。` : `An error occurred in ${region}.`)
          : (isZh ? '出现了一个意外错误。' : 'An unexpected error occurred.');

      return (
        <div style={{
          padding: '24px',
          color: 'var(--text-secondary, #888)',
          fontSize: '13px',
          textAlign: 'center',
        }}>
          <p style={{ marginBottom: '4px', fontWeight: 500 }}>{title}</p>
          <p style={{ marginBottom: '12px', fontSize: '12px', opacity: 0.7 }}>{hint}</p>
          <button
            onClick={this.handleRetry}
            style={{
              background: 'none',
              border: '1px solid var(--border-light, #ddd)',
              borderRadius: '4px',
              padding: '4px 12px',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: '12px',
            }}
          >
            {isZh ? '重试' : 'Retry'}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
