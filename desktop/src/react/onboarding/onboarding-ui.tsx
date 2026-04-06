/**
 * onboarding-ui.tsx — Shared UI primitives for the onboarding wizard
 */

export interface StepContainerProps {
  children: React.ReactNode;
  className?: string;
}
export interface MultilineProps { className?: string; text: string }

export function StepContainer({ children, className = '' }: StepContainerProps) {
  const mergedClassName = ['onboarding-step', 'active', className].filter(Boolean).join(' ');
  return <div className={mergedClassName} style={{ animation: 'obFadeIn 0.3s ease-out' }}>{children}</div>;
}

export function Multiline({ className, text }: MultilineProps) {
  const parts = text.split('\n');
  return (
    <p className={className}>
      {parts.map((line, idx) => (
        <span key={`ml-${idx}`}>{idx > 0 && <br />}{line}</span>
      ))}
    </p>
  );
}
