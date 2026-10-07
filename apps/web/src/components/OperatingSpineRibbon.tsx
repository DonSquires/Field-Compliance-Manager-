import { ArrowRight, Building2, CalendarDays, ClipboardCheck, FileBarChart, Handshake, MapPin, Radio, Users, WalletCards } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import './OperatingSpineRibbon.css';

type SpineItem = {
  id: string;
  label: string;
  context: string;
  icon: LucideIcon;
  page: string;
};

export function OperatingSpineRibbon({
  organizationName,
  agreementName,
  placeName,
  activePage,
  onNavigate,
}: {
  organizationName: string;
  agreementName: string | null;
  placeName: string | null;
  activePage: string;
  onNavigate: (page: string) => void;
}) {
  const items: SpineItem[] = [
    { id: 'organization', label: 'Organisation', context: organizationName, icon: Building2, page: 'crm' },
    { id: 'agreement', label: 'Agreement', context: agreementName ?? 'Select service', icon: Handshake, page: 'relationships' },
    { id: 'place', label: 'Place', context: placeName ?? 'Select site or zone', icon: MapPin, page: 'locations' },
    { id: 'staff', label: 'Staff', context: 'People & capability', icon: Users, page: 'people-hr' },
    { id: 'roster', label: 'Roster', context: 'Coverage & availability', icon: CalendarDays, page: 'roster' },
    { id: 'dispatch', label: 'Dispatch', context: 'Live response', icon: Radio, page: 'field-ops' },
    { id: 'compliance', label: 'Evidence', context: 'Field outcomes', icon: ClipboardCheck, page: 'field-ops' },
    { id: 'finance', label: 'Finance', context: 'Rates & billing', icon: WalletCards, page: 'crm' },
    { id: 'reports', label: 'Reports', context: 'Accountability', icon: FileBarChart, page: 'reports' },
  ];

  return (
    <nav className="operating-spine" aria-label="Operating spine">
      <span className="operating-spine-title">Service workflow</span>
      <div className="operating-spine-track">
        {items.map((item, index) => {
          const Icon = item.icon;
          const active = activePage === item.page;
          return (
            <span className="operating-spine-step" key={item.id}>
              <button type="button" className={active ? 'is-active' : ''} onClick={() => onNavigate(item.page)} aria-current={active ? 'step' : undefined}>
                <Icon size={15} aria-hidden="true" />
                <span><strong>{item.label}</strong><small>{item.context}</small></span>
              </button>
              {index < items.length - 1 && <ArrowRight size={14} aria-hidden="true" />}
            </span>
          );
        })}
      </div>
    </nav>
  );
}