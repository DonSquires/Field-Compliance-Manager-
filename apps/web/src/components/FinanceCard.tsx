import type { ReactNode } from 'react';
import './FinanceCard.css';

type FinanceCardProps = {
  eyebrow?: string;
  title: string;
  description: string;
  action: string;
  onClick?: () => void;
  tone?: 'primary' | 'neutral' | 'attention' | 'good';
  icon?: ReactNode;
  status?: string;
};

export function FinanceCard({ eyebrow, title, description, action, onClick, tone = 'neutral', icon, status }: FinanceCardProps) {
  return <button type="button" className={`finance-card finance-card-${tone}`} onClick={onClick}>
    <span className="finance-card-topline"><span>{icon}</span>{status && <b>{status}</b>}</span>
    {eyebrow && <span className="finance-card-eyebrow">{eyebrow}</span>}
    <strong className="finance-card-title">{title}</strong>
    <span className="finance-card-description">{description}</span>
    <span className="finance-card-action">{action} <span aria-hidden="true">&#8594;</span></span>
  </button>;
}
