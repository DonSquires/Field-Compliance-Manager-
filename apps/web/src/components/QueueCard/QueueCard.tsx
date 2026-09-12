import { ArrowRight, Binoculars, FileWarning, HeartPulse, Radio, ShieldAlert } from 'lucide-react';
import type { QueueKind, QueueItem } from '../../pages/AdminHubPage';

interface QueueCardProps {
  item: QueueItem;
  isNext: boolean;
  onOpen: () => void;
}

export function QueueCard({ item, isNext, onOpen }: QueueCardProps) {
  const Icon = item.kind === 'welfare' ? HeartPulse : item.kind === 'dispatch' ? Radio : item.kind === 'breach' ? ShieldAlert : item.kind === 'video' ? Binoculars : FileWarning;

  return (
    <button type="button" className={`admin-queue-row kind-${item.kind} ${isNext ? 'is-next' : ''}`} onClick={onOpen}>
      <span className="admin-queue-icon"><Icon size={18} aria-hidden="true" /></span>
      <div><strong>{item.title}</strong><span>{isNext ? 'Next action · ' : ''}{item.detail}</span></div>
      <span className="admin-queue-status">{item.status.replace(/_/g, ' ')}</span>
      <time dateTime={item.occurredAt}>{relativeTime(item.occurredAt)}</time>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}