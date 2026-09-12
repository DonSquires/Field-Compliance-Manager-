# Field Compliance Manager: UI/UX Implementation Guide

**Phase:** Design System + Component Refactor  
**Status:** Ready for Implementation  
**Priority:** Start with AdminShell + card components

---

## PART 1: UPDATED COLOR & SPACING SYSTEM

### Color Tokens (CSS Variables)

Create a new file: `apps/web/src/styles/theme-tokens.css`

```css
:root {
  /* BACKGROUND LAYER */
  --color-bg-primary: #07131b;      /* Main app background */
  --color-bg-secondary: #0c1a24;    /* Nested/secondary backgrounds */
  --color-bg-tertiary: #0f1e2a;     /* Card backgrounds */
  --color-bg-raised: #152835;       /* Elevated cards, hover state */
  
  /* BORDER LAYER */
  --color-border-primary: #1c4353;  /* Standard borders */
  --color-border-secondary: #2a5f7a;/* Hover/active borders */
  --color-border-tertiary: #1a3a47; /* Subtle borders */
  
  /* TEXT LAYER */
  --color-text-primary: #e8f0f3;    /* Main text */
  --color-text-secondary: #8fa4ae;  /* Secondary text, labels */
  --color-text-tertiary: #6d7d89;   /* Tertiary, helper text */
  --color-text-muted: #5a6b77;      /* Very muted (timestamps, etc.) */
  
  /* SEMANTIC COLORS */
  --color-success: #2ecc71;         /* Green - operational success */
  --color-success-bg: #1a3a2e;      /* Green - background */
  --color-success-text: #5eead4;    /* Green - readable text */
  
  --color-warning: #f39c12;         /* Orange - caution */
  --color-warning-bg: #3d2d1f;      /* Orange - background */
  --color-warning-text: #fbbf24;    /* Orange - readable text */
  
  --color-error: #e74c3c;           /* Red - destructive */
  --color-error-bg: #3a211f;        /* Red - background */
  --color-error-text: #fca5a5;      /* Red - readable text */
  
  --color-info: #3498db;            /* Blue - informational */
  --color-info-bg: #1f3449;         /* Blue - background */
  --color-info-text: #93c5fd;       /* Blue - readable text */
  
  --color-primary-action: #1a9876;  /* Teal - primary CTA */
  --color-primary-action-hover: #15b89c;
  --color-secondary-action: #4a6b7d;/* Muted blue - secondary CTA */
  
  /* SPACING SCALE */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-2xl: 48px;
  
  /* TYPOGRAPHY */
  --font-family-base: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'IBM Plex Sans', sans-serif;
  --font-family-mono: 'JetBrains Mono', 'Courier New', monospace;
  
  /* LINE HEIGHT */
  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;
  
  /* BORDER RADIUS */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  
  /* SHADOWS */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.2);
  --shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.3);
  
  /* Z-INDEX SCALE */
  --z-dropdown: 100;
  --z-sticky: 10;
  --z-modal: 200;
  --z-tooltip: 150;
}
```

---

## PART 2: NEW COMPONENT PATTERNS (CSS)

### Component 1: Card / Container Wrapper

File: `apps/web/src/components/Card/Card.tsx` + `Card.css`

```tsx
// Card.tsx
import React from 'react';
import './Card.css';

type CardVariant = 'default' | 'elevated' | 'interactive' | 'section';
type CardSize = 'compact' | 'normal' | 'spacious';

interface CardProps {
  variant?: CardVariant;
  size?: CardSize;
  children: React.ReactNode;
  onClick?: () => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  size = 'normal',
  children,
  onClick,
  header,
  footer,
}) => {
  return (
    <div 
      className={`card card--${variant} card--${size} ${onClick ? 'card--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {header && <div className="card-header">{header}</div>}
      <div className="card-body">{children}</div>
      {footer && <div className="card-footer">{footer}</div>}
    </div>
  );
};

export default Card;
```

```css
/* Card.css */
.card {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--radius-lg);
  transition: all 200ms ease;
}

.card--default {
  padding: var(--spacing-md);
}

.card--spacious {
  padding: var(--spacing-lg);
}

.card--compact {
  padding: var(--spacing-sm);
}

.card:hover {
  border-color: var(--color-border-secondary);
}

.card--interactive:hover {
  background: var(--color-bg-raised);
  cursor: pointer;
}

.card--elevated {
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid var(--color-border-primary);
}

.card-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.card-body {
  display: grid;
  gap: var(--spacing-md);
}

.card-footer {
  display: flex;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--color-border-primary);
  justify-content: flex-end;
}

.card--clickable {
  cursor: pointer;
  user-select: none;
}

.card--clickable:focus-visible {
  outline: 2px solid var(--color-primary-action);
  outline-offset: 2px;
}
```

---

### Component 2: Badge / Status Pill

File: `apps/web/src/components/Badge/Badge.tsx` + `Badge.css`

```tsx
// Badge.tsx
import React from 'react';
import './Badge.css';

type BadgeStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps {
  status?: BadgeStatus;
  size?: BadgeSize;
  children: React.ReactNode;
  icon?: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({ 
  status = 'neutral', 
  size = 'md',
  children,
  icon,
}) => {
  return (
    <span className={`badge badge--${status} badge--${size}`}>
      {icon && <span className="badge-icon">{icon}</span>}
      <span>{children}</span>
    </span>
  );
};

export default Badge;
```

```css
/* Badge.css */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-xl);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.badge--sm {
  padding: 2px 8px;
  font-size: 10px;
}

.badge--md {
  padding: 4px 12px;
  font-size: 12px;
}

.badge--lg {
  padding: 6px 16px;
  font-size: 14px;
}

.badge-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Status Variants */
.badge--success {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.badge--warning {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

.badge--error {
  background: var(--color-error-bg);
  color: var(--color-error-text);
}

.badge--info {
  background: var(--color-info-bg);
  color: var(--color-info-text);
}

.badge--neutral {
  background: var(--color-border-primary);
  color: var(--color-text-secondary);
}
```

---

### Component 3: Master-Detail Layout

File: `apps/web/src/layouts/MasterDetailLayout/MasterDetailLayout.tsx` + `styles.css`

```tsx
// MasterDetailLayout.tsx
import React, { useState } from 'react';
import './styles.css';

interface MasterDetailLayoutProps {
  master: React.ReactNode;      /* Left: List/Queue */
  detail: React.ReactNode;      /* Right: Detail Panel */
  masterWidth?: number;          /* Default: 320px */
}

export const MasterDetailLayout: React.FC<MasterDetailLayoutProps> = ({
  master,
  detail,
  masterWidth = 320,
}) => {
  const [masterSize, setMasterSize] = useState(masterWidth);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const newWidth = Math.max(250, Math.min(600, e.clientX));
    setMasterSize(newWidth);
  };

  return (
    <div 
      className="layout-master-detail"
      style={{ gridTemplateColumns: `${masterSize}px 1fr` }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div className="layout-master-detail__master">
        {master}
      </div>

      <div 
        className="layout-master-detail__divider"
        onMouseDown={handleMouseDown}
        aria-label="Resize master panel"
        role="separator"
      />

      <div className="layout-master-detail__detail">
        {detail}
      </div>
    </div>
  );
};

export default MasterDetailLayout;
```

```css
/* MasterDetailLayout/styles.css */
.layout-master-detail {
  display: grid;
  gap: 0;
  height: 100%;
  min-height: 100vh;
}

.layout-master-detail__master {
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid var(--color-border-primary);
  background: var(--color-bg-secondary);
  padding: var(--spacing-md);
}

.layout-master-detail__divider {
  width: 4px;
  background: var(--color-border-primary);
  cursor: col-resize;
  transition: background 200ms ease;
  position: relative;
}

.layout-master-detail__divider:hover {
  background: var(--color-border-secondary);
}

.layout-master-detail__detail {
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--spacing-md);
}

/* Mobile: Stack vertically */
@media (max-width: 1024px) {
  .layout-master-detail {
    grid-template-columns: 1fr;
    grid-template-rows: 240px 1fr;
  }

  .layout-master-detail__master {
    border-right: 0;
    border-bottom: 1px solid var(--color-border-primary);
  }

  .layout-master-detail__divider {
    width: 100%;
    height: 4px;
    cursor: row-resize;
  }
}
```

---

### Component 4: Action Ribbon (Sticky Footer)

File: `apps/web/src/components/ActionRibbon/ActionRibbon.tsx` + `styles.css`

```tsx
// ActionRibbon.tsx
import React from 'react';
import './styles.css';

interface ActionRibbonProps {
  primary?: React.ReactNode;        /* Left side (e.g., "Cancel") */
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'destructive';
    disabled?: boolean;
  }>;
}

export const ActionRibbon: React.FC<ActionRibbonProps> = ({ primary, actions }) => {
  return (
    <div className="action-ribbon">
      {primary && <div className="action-ribbon__primary">{primary}</div>}
      
      <div className="action-ribbon__actions">
        {actions.map((action, idx) => (
          <button
            key={idx}
            className={`action-ribbon__button action-ribbon__button--${action.variant || 'secondary'}`}
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ActionRibbon;
```

```css
/* ActionRibbon/styles.css */
.action-ribbon {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--color-border-primary);
  z-index: var(--z-sticky);
}

.action-ribbon__primary {
  margin-right: auto;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.action-ribbon__actions {
  display: flex;
  gap: var(--spacing-sm);
}

.action-ribbon__button {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 8px 16px;
  border: 1px solid var(--color-border-primary);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 200ms ease;
}

.action-ribbon__button:hover:not(:disabled) {
  border-color: var(--color-border-secondary);
  background: var(--color-bg-raised);
}

.action-ribbon__button:focus-visible {
  outline: 2px solid var(--color-primary-action);
  outline-offset: 2px;
}

.action-ribbon__button--primary {
  background: var(--color-primary-action);
  border-color: var(--color-primary-action);
  color: #ffffff;
}

.action-ribbon__button--primary:hover:not(:disabled) {
  background: var(--color-primary-action-hover);
  border-color: var(--color-primary-action-hover);
}

.action-ribbon__button--destructive {
  color: var(--color-error-text);
  border-color: var(--color-error-bg);
}

.action-ribbon__button--destructive:hover:not(:disabled) {
  background: var(--color-error-bg);
}

.action-ribbon__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

---

## PART 3: NAVIGATION SHELL REFACTOR

### New AdminShell Navigation Structure

File: `apps/web/src/shells/AdminShell-navigation-config.ts`

```typescript
// AdminShell-navigation-config.ts
// Replace flat sidebar with workflow-first navigation

export type NavCategory = 
  | 'daily-work'
  | 'field-ops'
  | 'people'
  | 'finance'
  | 'sites'
  | 'organizations'
  | 'reports'
  | 'config'
  | 'help';

export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path?: string;
  category: NavCategory;
  children?: NavItem[];
  isEnabled?: (role: string, modules: string[]) => boolean;
}

export const ADMIN_NAVIGATION: Record<NavCategory, { label: string; icon: React.ReactNode; items: NavItem[] }> = {
  'daily-work': {
    label: '🎯 My Daily Work',
    icon: null,
    items: [
      { id: 'active-queue', label: 'Active Tasks', path: '/admin/queue', category: 'daily-work', icon: null },
      { id: 'team-status', label: "Team's Status", path: '/admin/team', category: 'daily-work', icon: null },
      { id: 'alerts', label: 'Alerts & Breaches', path: '/admin/alerts', category: 'daily-work', icon: null },
    ],
  },
  'field-ops': {
    label: '📍 Field Operations',
    icon: null,
    items: [
      { id: 'live-map', label: 'Live Map & Dispatch', path: '/admin/field-ops?area=live-map', category: 'field-ops', icon: null },
      { id: 'dispatch', label: 'Dispatch Console', path: '/admin/field-ops?area=dispatch', category: 'field-ops', icon: null },
      { id: 'incidents', label: 'Incident Reports', path: '/admin/field-ops?area=incidents', category: 'field-ops', icon: null },
      { id: 'cctv', label: 'CCTV & Patrol Logs', path: '/admin/field-ops?area=cctv', category: 'field-ops', icon: null },
      { id: 'welfare', label: 'Welfare & Safety', path: '/admin/field-ops?area=welfare', category: 'field-ops', icon: null },
    ],
  },
  'people': {
    label: '👥 People & Rosters',
    icon: null,
    items: [
      { id: 'roster', label: 'Staff Schedules', path: '/admin/roster', category: 'people', icon: null },
      { id: 'rules', label: 'Rostering Rules', path: '/admin/roster-rules', category: 'people', icon: null },
      { id: 'access', label: 'Access & Permissions', path: '/admin/access', category: 'people', icon: null },
      { id: 'users', label: 'User Management', path: '/admin/users', category: 'people', icon: null },
    ],
  },
  'finance': {
    label: '💰 Finance & Billing',
    icon: null,
    items: [
      { id: 'rates', label: 'Billing Rules & Rates', path: '/admin/rates', category: 'finance', icon: null },
      { id: 'money', label: 'Money & Accounts', path: '/admin/finance/money', category: 'finance', icon: null },
      { id: 'invoicing', label: 'Invoicing & Reports', path: '/admin/finance/invoicing', category: 'finance', icon: null },
      { id: 'costs', label: 'Cost Management', path: '/admin/finance/costs', category: 'finance', icon: null },
    ],
  },
  'sites': {
    label: '🏠 Sites & Places',
    icon: null,
    items: [
      { id: 'sites', label: 'Site Management', path: '/admin/sites', category: 'sites', icon: null },
      { id: 'boundaries', label: 'Boundaries & Zones', path: '/admin/boundaries', category: 'sites', icon: null },
      { id: 'access-rules', label: 'Access Rules', path: '/admin/access-rules', category: 'sites', icon: null },
      { id: 'locations', label: 'Location Data', path: '/admin/locations', category: 'sites', icon: null },
    ],
  },
  'organizations': {
    label: '🤝 Organizations & CRM',
    icon: null,
    items: [
      { id: 'onboarding', label: 'Account Onboarding', path: '/admin/onboarding', category: 'organizations', icon: null },
      { id: 'portfolio', label: 'Client Portfolio', path: '/admin/crm', category: 'organizations', icon: null },
      { id: 'handoffs', label: 'Activation Handoffs', path: '/admin/handoffs', category: 'organizations', icon: null },
      { id: 'relationships', label: 'Relationships', path: '/admin/relationships', category: 'organizations', icon: null },
    ],
  },
  'reports': {
    label: '📊 Reports & Analytics',
    icon: null,
    items: [
      { id: 'dashboard', label: 'Compliance Dashboard', path: '/admin/reports', category: 'reports', icon: null },
      { id: 'operations', label: 'Operational Reports', path: '/admin/reports/operations', category: 'reports', icon: null },
      { id: 'financial', label: 'Financial Reports', path: '/admin/reports/financial', category: 'reports', icon: null },
    ],
  },
  'config': {
    label: '⚙️ Configuration & Admin',
    icon: null,
    items: [
      { id: 'org-settings', label: 'Organization Settings', path: '/admin/settings/org', category: 'config', icon: null },
      { id: 'users-roles', label: 'Users & Roles', path: '/admin/settings/users', category: 'config', icon: null },
      { id: 'approvals', label: 'Approvals & Workflows', path: '/admin/approvals', category: 'config', icon: null },
      { id: 'system', label: 'System Tools', path: '/admin/settings/system', category: 'config', icon: null },
    ],
  },
  'help': {
    label: '❓ Help & Support',
    icon: null,
    items: [
      { id: 'docs', label: 'Documentation', path: '/help/docs', category: 'help', icon: null },
      { id: 'support', label: 'Contact Support', path: '/help/support', category: 'help', icon: null },
      { id: 'release', label: 'Release Notes', path: '/help/release', category: 'help', icon: null },
    ],
  },
};
```

---

## PART 4: QUICK START (For First Page Redesign)

### Example: FileSystemPage Refactor (Master-Detail + Cards)

**Current Layout Problem:**  
- All batches, mappings, and details on one screen
- User scrolls through 50+ rows to find what they need

**New Layout:**  
- Left: Compact batch queue (card-based, minimal info)
- Right: Batch detail (summary card + schema preview + actions)
- Progressive disclosure: Click card to expand details

**Implementation Steps:**

1. **Wrap FileSystemPage in MasterDetailLayout**
```tsx
import { MasterDetailLayout } from '../layouts/MasterDetailLayout';

export default function FileSystemPage() {
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  
  return (
    <MasterDetailLayout
      master={<BatchQueue onSelectBatch={setSelectedBatchId} />}
      detail={selectedBatchId ? <BatchDetail id={selectedBatchId} /> : <EmptyState />}
      masterWidth={320}
    />
  );
}
```

2. **Create BatchQueue (Master List)**
```tsx
// Show compact cards: name, status, date
// Click to select
// Use Card component with icon + title + status badge
```

3. **Create BatchDetail (Detail Pane)**
```tsx
// Summary card: file count, total bytes, status
// Schema preview card: column mappings (expandable)
// History card: expandable log
// Action ribbon: [Approve] [Reject] [Map Columns]
```

4. **CSS: Apply new spacing & colors**
```css
@import 'theme-tokens.css';
/* Use var(--spacing-*), var(--color-*) throughout */
```

---

## NEXT STEPS

1. **Create `apps/web/src/styles/theme-tokens.css`** with all color + spacing variables
2. **Build Card + Badge + ActionRibbon + MasterDetailLayout components**
3. **Update AdminShell navigation** to use new category structure
4. **Pick ONE page** (FileSystemPage recommended) and refactor it
5. **Test on real users** before scaling to other pages
6. **Document patterns** as you build (for consistency across team)

---

**This is your starting blueprint. Adapt as needed for your specific data models and workflows.**

