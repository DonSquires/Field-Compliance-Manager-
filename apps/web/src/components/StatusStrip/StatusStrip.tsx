import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';

export type StatusTone = 'normal' | 'watch' | 'action' | 'critical';

interface StatusStripProps {
  tone: StatusTone;
  children: ReactNode;
}

export function StatusStrip({ tone, children }: StatusStripProps) {
  const Icon = tone === 'normal' ? CheckCircle2 : tone === 'critical' || tone === 'action' ? AlertTriangle : Info;

  return (
    <div className={`status-strip status-strip--${tone}`} role="status">
      <Icon size={18} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}