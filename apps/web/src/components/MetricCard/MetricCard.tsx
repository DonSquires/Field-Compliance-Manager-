import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';

interface MetricCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  tone: string;
  unavailable?: boolean;
  title?: string;
  onClick: () => void;
}

export function MetricCard({ icon: Icon, label, value, tone, unavailable = false, title, onClick }: MetricCardProps) {
  return (
    <button type="button" className={`admin-metric tone-${tone} ${unavailable ? 'is-unavailable' : ''}`} onClick={onClick} title={title}>
      <span className="admin-metric-icon"><Icon size={19} aria-hidden="true" /></span>
      <span>{label}</span>
      <strong>{value}</strong>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}