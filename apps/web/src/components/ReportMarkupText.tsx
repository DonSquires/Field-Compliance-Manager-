import type { ReactNode } from 'react';
import type { MarkupItem } from '../lib/reportActivity';

/** Headings, bullets and paragraphs from summaryMarkup, rendered as React text (never HTML). */
export function MarkupText({ items }: { items: MarkupItem[] }) {
  const blocks: ReactNode[] = [];
  let bullets: MarkupItem[] = [];
  const runs = (item: MarkupItem) => item.runs.map((run, index) => (run.bold ? <strong key={index}>{run.text}</strong> : <span key={index}>{run.text}</span>));
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={`list-${blocks.length}`} className="report-activity-summary-list">{bullets.map((item, index) => <li key={index}>{runs(item)}</li>)}</ul>);
    bullets = [];
  };
  for (const item of items) {
    if (item.style === 'bullet') { bullets.push(item); continue; }
    flush();
    blocks.push(item.style === 'heading'
      ? <p key={`heading-${blocks.length}`} className="report-activity-summary-heading">{item.runs.map((run) => run.text).join('')}</p>
      : <p key={`text-${blocks.length}`} className="report-activity-summary-text">{runs(item)}</p>);
  }
  flush();
  return <>{blocks}</>;
}
