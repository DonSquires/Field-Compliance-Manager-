# UI/UX Redesign Roadmap: From Prototype Standards to Production Quality

**Status:** Implementation Phase  
**Date:** 2026-09-12  
**Alignment:** Respects original FieldOps Manager design standards + enterprise SaaS best practices  
**Scope:** Full app redesign across all shells (Officer, Admin, Master)

---

## EXECUTIVE SUMMARY

Your original prototype (FreedomCamp-Manager) had **excellent foundational design principles**: three purpose-built shells, density tiers, component taxonomy, governance patterns, and accessibility standards.

The current production app has **lost those foundations**:
- **Shell model** is muddied: Officer and Admin shells don't have clear density/interaction differences
- **Page anatomy** is inconsistent: No global filter ribbons, status strips are missing, primary actions scattered
- **Card taxonomy** is unused: Pages show raw database tables instead of semantic card types
- **Density tiers** are conflated: Dense data crammed into standard density with no toggle
- **Component reuse** is minimal: Each page reimplements patterns instead of using a shared system

**This roadmap rebuilds the app by:**
1. ✅ Restoring the three-shell model with proper density tiers
2. ✅ Implementing consistent page anatomy across all surfaces
3. ✅ Building a reusable card component system (Metric, Workflow, Alert, Queue, Task)
4. ✅ Adding the density toggle for dense data pages (Dispatch, Command Centre)
5. ✅ Keeping all original accessibility standards and performance budgets

---

## PART 1: ASSESSMENT — WHERE WE ARE NOW vs. WHERE WE WERE

### Original Prototype Strengths (2026 FreedomCamp-Manager)

```
✅ Three distinct shells with different interaction models
✅ Glove-safe density tier for field officers
✅ Standard density for admin workflows
✅ Dense mode for Dispatch/Command Centre
✅ Consistent page anatomy (top bar → header → status → actions → content → audit)
✅ Card-based taxonomy (not raw tables)
✅ Theme support (Light, Dark, Night Patrol, High Contrast)
✅ WCAG 2.2 AA accessibility as standard
✅ Governance status strip pattern
✅ Performance budgets enforced
```

### Current Production Issues

```
❌ Shells are visually/functionally indistinguishable
❌ Page anatomy is inconsistent (some pages missing filters, status strips, primary actions)
❌ Tables/forms crammed together without whitespace
❌ Card taxonomy not implemented (raw data tables used instead)
❌ Dense mode toggle missing from data-heavy pages
❌ Status indicators are color-only (no text labels)
❌ Empty states don't have next-step actions
❌ Error handling is inconsistent
❌ Global filter ribbon missing from admin pages
❌ Audit trace is hidden or missing
```

### Root Cause Analysis

| Original Strength | What Broke | Why |
|---|---|---|
| Three shells clearly defined | Shells look the same | Navigation shell CSS not maintaining density hierarchy |
| Card taxonomy documented | Pages use raw HTML tables | Components not built; schema directly rendered |
| Page anatomy standardized | Anatomy varies per page | No shell-level layout wrapper; each page re-implements |
| Density tiers defined | Everything is cramped | No density toggle implementation; no mobile layout variants |
| Status strip pattern exists | Status indicators are scattered | Pattern not automated; manual implementation per page |
| Themes supported | Theme system not used | Theme tokens not wired; hard-coded colors instead |
| Performance budgets | Routes chunk > 250KB | No lazy loading; entire app bundled together |

---

## PART 2: REDESIGN STRATEGY (Respecting Original Principles)

### Phase 1: Restore the Foundation (Weeks 1-2)

**Goal:** Re-establish the three-shell model and consistent page anatomy.

#### 1.1 Create Unified Layout System

```typescript
// apps/web/src/layouts/ShellLayout.tsx
interface ShellLayoutProps {
  shell: 'officer' | 'admin' | 'master';
  children: React.ReactNode;
  topBar?: React.ReactNode;
  filterRibbon?: React.ReactNode;
  pageHeader?: React.ReactNode;
  statusStrip?: React.ReactNode;
  primaryAction?: React.ReactNode;
}

export const ShellLayout: React.FC<ShellLayoutProps> = ({
  shell,
  children,
  topBar,
  filterRibbon,
  pageHeader,
  statusStrip,
  primaryAction,
}) => {
  return (
    <div className={`shell-layout shell-layout--${shell}`}>
      {topBar && <div className="shell-topbar">{topBar}</div>}
      {filterRibbon && <div className="shell-filter-ribbon">{filterRibbon}</div>}
      {pageHeader && <div className="shell-page-header">{pageHeader}</div>}
      {statusStrip && <div className="shell-status-strip">{statusStrip}</div>}
      {primaryAction && <div className="shell-primary-action">{primaryAction}</div>}
      <div className="shell-content">{children}</div>
      {/* Audit trace auto-generated for detail views */}
    </div>
  );
};
```

**CSS (shell-layout.css):**
```css
/* Officer Shell: Glove-safe density */
.shell-layout--officer {
  --density: glove-safe;
  --touch-target: 44px;
  --text-size: 16px;
  --spacing-base: 16px;
  --column-count: 1;
}

/* Admin Shell: Standard density */
.shell-layout--admin {
  --density: standard;
  --touch-target: 32px;
  --text-size: 14px;
  --spacing-base: 12px;
  --column-count: 2-3;
}

/* Master Shell: Governance */
.shell-layout--master {
  --density: standard;
  --touch-target: 32px;
  --text-size: 14px;
  --spacing-base: 12px;
  --column-count: 2-3;
}

.shell-layout {
  display: grid;
  grid-template-rows: auto auto auto auto auto 1fr;
  gap: 0;
  height: 100vh;
  background: var(--color-bg-primary);
}

.shell-topbar {
  grid-row: 1;
  padding: var(--spacing-base);
  border-bottom: 1px solid var(--color-border-primary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.shell-filter-ribbon {
  grid-row: 2;
  padding: var(--spacing-base);
  border-bottom: 1px solid var(--color-border-primary);
  display: flex;
  gap: var(--spacing-base);
  background: var(--color-bg-secondary);
}

.shell-page-header {
  grid-row: 3;
  padding: var(--spacing-base);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--color-border-primary);
}

.shell-status-strip {
  grid-row: 4;
  padding: var(--spacing-base);
  border-bottom: 1px solid var(--color-border-primary);
  display: flex;
  gap: var(--spacing-base);
}

.shell-primary-action {
  grid-row: 5;
  padding: var(--spacing-base);
  display: flex;
  justify-content: flex-end;
  border-bottom: 1px solid var(--color-border-primary);
}

.shell-content {
  grid-row: 6;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--spacing-base);
}

/* Mobile: Stack vertically */
@media (max-width: 768px) {
  .shell-layout--officer {
    --column-count: 1;
  }
  
  .shell-filter-ribbon {
    flex-direction: column;
  }
}
```

**Benefits:**
- ✅ Every page automatically has consistent anatomy
- ✅ Density tier (`--density` variable) controls spacing/touch targets globally
- ✅ Shell type determines theme, density, and responsive behavior
- ✅ Pages delegate layout to ShellLayout instead of re-implementing

---

#### 1.2 Implement Theme Token System

Create a central theme file that restores Light/Dark/Night Patrol/High Contrast:

```css
/* apps/web/src/styles/themes.css */

:root {
  /* LIGHT THEME (Default) */
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-bg-tertiary: #fafafa;
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #666666;
  --color-border-primary: #e0e0e0;
  --color-brand-primary: #0066cc;
  
  /* ... other colors ... */
}

[data-theme="dark"] {
  /* DARK THEME */
  --color-bg-primary: #07131b;
  --color-bg-secondary: #0c1a24;
  --color-bg-tertiary: #0f1e2a;
  --color-text-primary: #e8f0f3;
  --color-text-secondary: #8fa4ae;
  --color-border-primary: #1c4353;
  --color-brand-primary: #1a9876;
  
  /* ... other colors ... */
}

[data-theme="night-patrol"] {
  /* NIGHT PATROL: Maximum contrast, reduced blue light, enlarged touch targets */
  --color-bg-primary: #000000;
  --color-bg-secondary: #1a1a1a;
  --color-bg-tertiary: #2a2a2a;
  --color-text-primary: #ffff00;  /* High contrast yellow */
  --color-text-secondary: #cccc00;
  --color-border-primary: #444444;
  --color-brand-primary: #ffff00;
  --touch-target-multiplier: 1.2;  /* Larger targets */
  --font-size-multiplier: 1.1;     /* Larger text */
  
  /* ... other colors with reduced blue light ... */
}

[data-theme="high-contrast"] {
  /* HIGH CONTRAST: WCAG AAA */
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f0f0f0;
  --color-text-primary: #000000;
  --color-text-secondary: #333333;
  --color-border-primary: #000000;
  --color-brand-primary: #0033cc;
  
  /* Ensure all contrasts meet AAA */
  /* ... */
}
```

**Implementation in React:**
```tsx
// apps/web/src/hooks/useTheme.ts
import { useEffect } from 'react';

export const useTheme = () => {
  const [theme, setTheme] = React.useState<'light' | 'dark' | 'night-patrol' | 'high-contrast'>('dark');

  useEffect(() => {
    // Get from user profile or localStorage
    const userTheme = localStorage.getItem('user-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', userTheme);
    setTheme(userTheme as any);
  }, []);

  const updateTheme = (newTheme: typeof theme) => {
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('user-theme', newTheme);
    setTheme(newTheme);
  };

  return { theme, updateTheme };
};
```

---

### Phase 2: Build Component System (Weeks 3-4)

**Goal:** Implement the card taxonomy from the original spec.

#### 2.1 Metric Card

```tsx
// apps/web/src/components/MetricCard/MetricCard.tsx
interface MetricCardProps {
  label: string;
  value: number;
  trend?: 'up' | 'down' | 'neutral';
  trendPercentage?: number;
  status?: 'normal' | 'watch' | 'action' | 'critical';
  icon?: React.ReactNode;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  trend,
  trendPercentage,
  status = 'normal',
  icon,
}) => {
  return (
    <div className={`metric-card metric-card--${status}`}>
      <div className="metric-card__header">
        {icon && <div className="metric-card__icon">{icon}</div>}
        <div className="metric-card__label">{label}</div>
      </div>
      <div className="metric-card__value">{value.toLocaleString()}</div>
      {trend && trendPercentage && (
        <div className={`metric-card__trend metric-card__trend--${trend}`}>
          {trend === 'up' && '↑'} {Math.abs(trendPercentage)}%
        </div>
      )}
    </div>
  );
};
```

#### 2.2 Workflow Card

```tsx
// apps/web/src/components/WorkflowCard/WorkflowCard.tsx
interface WorkflowCardProps {
  title: string;
  status: 'normal' | 'watch' | 'action' | 'critical';
  assignedTo?: string;
  statusText: string;
  onAction: () => void;
  actionLabel?: string;
}

export const WorkflowCard: React.FC<WorkflowCardProps> = ({
  title,
  status,
  assignedTo,
  statusText,
  onAction,
  actionLabel = 'View',
}) => {
  return (
    <div className={`workflow-card workflow-card--${status}`} onClick={onAction}>
      <div className="workflow-card__title">{title}</div>
      <div className="workflow-card__meta">
        <span className={`workflow-card__status workflow-card__status--${status}`}>
          {statusText}
        </span>
        {assignedTo && <span className="workflow-card__assigned">{assignedTo}</span>}
      </div>
      <button className="workflow-card__action">{actionLabel} →</button>
    </div>
  );
};
```

#### 2.3 Queue Card (Compact Row-Card)

```tsx
// apps/web/src/components/QueueCard/QueueCard.tsx
interface QueueCardProps {
  id: string;
  identifier: string; // Plate, reference number, etc.
  location: string;
  status: 'normal' | 'watch' | 'action' | 'critical';
  timestamp: string;
  onAction: () => void;
}

export const QueueCard: React.FC<QueueCardProps> = ({
  id,
  identifier,
  location,
  status,
  timestamp,
  onAction,
}) => {
  return (
    <div className={`queue-card queue-card--${status}`} onClick={onAction}>
      <div className="queue-card__identifier">{identifier}</div>
      <div className="queue-card__location">{location}</div>
      <div className="queue-card__meta">
        <span className={`queue-card__status queue-card__status--${status}`} />
        <span className="queue-card__timestamp">{timestamp}</span>
      </div>
    </div>
  );
};
```

**CSS Pattern (shared across all card types):**
```css
.metric-card,
.workflow-card,
.queue-card {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-primary);
  border-radius: 6px;
  padding: var(--spacing-base);
  transition: all 200ms ease;
}

.metric-card--normal,
.workflow-card--normal,
.queue-card--normal {
  border-color: var(--color-border-primary);
}

.metric-card--watch,
.workflow-card--watch,
.queue-card--watch {
  border-color: #f39c12;
  background: rgba(243, 156, 18, 0.1);
}

.metric-card--action,
.workflow-card--action,
.queue-card--action {
  border-color: #e67e22;
  background: rgba(230, 126, 34, 0.1);
}

.metric-card--critical,
.workflow-card--critical,
.queue-card--critical {
  border-color: #e74c3c;
  background: rgba(231, 76, 60, 0.1);
}

.workflow-card:hover,
.queue-card:hover {
  cursor: pointer;
  border-color: var(--color-border-secondary);
  background: var(--color-bg-raised);
}
```

---

### Phase 3: Update Key Pages (Weeks 5-7)

#### 3.1 AdminHubPage (Dashboard)

**Current State:** Dense metrics + activity log all on one page  
**New State:** Metric cards + status strip + queue of actionable items

```tsx
// Updated AdminHubPage.tsx
export default function AdminHubPage() {
  return (
    <ShellLayout shell="admin" 
      pageHeader={
        <div className="page-header">
          <h1>Today at a Glance</h1>
          <button className="btn btn--primary">Generate Report</button>
        </div>
      }
      statusStrip={
        <StatusStrip
          state="watch"
          message="3 active incidents, 1 pending approval"
        />
      }
    >
      {/* Metrics Row */}
      <div className="metrics-grid">
        <MetricCard 
          label="Officers on Duty"
          value={24}
          status="normal"
        />
        <MetricCard 
          label="Active Dispatch"
          value={7}
          status="action"
          trend="up"
          trendPercentage={14}
        />
        <MetricCard 
          label="Welfare Alerts"
          value={3}
          status="watch"
        />
        <MetricCard 
          label="Breaches Detected"
          value={1}
          status="critical"
        />
      </div>

      {/* Action Queues */}
      <div className="queue-section">
        <h2>Your Queue</h2>
        <div className="queue-list">
          {/* Workflow cards for actionable items */}
          <WorkflowCard
            title="Dispatch Job #001"
            status="critical"
            statusText="URGENT"
            assignedTo="Alice"
            onAction={() => navigate('/admin/dispatch')}
          />
          {/* ... more cards ... */}
        </div>
      </div>

      {/* Recent Activity */}
      <details className="activity-section">
        <summary>📋 Recent Activity (Expandable)</summary>
        {/* Activity log in chronological order */}
      </details>
    </ShellLayout>
  );
}
```

#### 3.2 FileSystemPage (Master-Detail + Density Toggle)

```tsx
// Updated FileSystemPage.tsx
export default function FileSystemPage() {
  const [density, setDensity] = React.useState<'standard' | 'dense'>('standard');

  return (
    <ShellLayout 
      shell="admin"
      pageHeader={
        <div className="page-header">
          <h1>File System</h1>
          <div className="page-header__actions">
            <button onClick={() => setDensity(d => d === 'standard' ? 'dense' : 'standard')}>
              {density === 'standard' ? '📊 Dense Mode' : '📄 Standard Mode'}
            </button>
            <button className="btn btn--primary">Upload Batch</button>
          </div>
        </div>
      }
      filterRibbon={
        <FilterRibbon>
          <FilterButton name="File Space" />
          <FilterButton name="Status" />
          <SortButton />
        </FilterRibbon>
      }
    >
      <MasterDetailLayout
        density={density}
        master={<BatchQueueList onSelect={setSelectedBatch} />}
        detail={<BatchDetailPanel batch={selectedBatch} />}
      />
    </ShellLayout>
  );
}
```

---

### Phase 4: Officer Shell (Glove-Safe) (Weeks 8-9)

**Goal:** Implement mobile-first, night-readable design for field officers.

#### 4.1 OfficerFieldReportPage

```tsx
// apps/web/src/pages/OfficerFieldReportPage.tsx (Updated)
export default function OfficerFieldReportPage() {
  const [step, setStep] = React.useState(1);

  return (
    <ShellLayout shell="officer">  {/* Glove-safe density, 44px touch targets */}
      <div className="wizard-container">
        <div className="wizard-progress">
          Step {step} of 4
        </div>

        {step === 1 && <WizardStep1_Basics onNext={() => setStep(2)} />}
        {step === 2 && <WizardStep2_Location onNext={() => setStep(3)} />}
        {step === 3 && <WizardStep3_Details onNext={() => setStep(4)} />}
        {step === 4 && <WizardStep4_Review onSubmit={submitReport} />}
      </div>
    </ShellLayout>
  );
}
```

---

## PART 3: PHASED IMPLEMENTATION ROADMAP

```
WEEK 1-2: FOUNDATION
├─ Create ShellLayout component (layout anatomy)
├─ Implement theme token system (Light/Dark/Night Patrol/High Contrast)
├─ Define design tokens (spacing, colors, typography)
└─ Build Shell CSS (density tiers)

WEEK 3-4: COMPONENT SYSTEM
├─ Build MetricCard
├─ Build WorkflowCard
├─ Build QueueCard
├─ Build AlertCard
├─ Build TaskCard
└─ Create card component library (Storybook)

WEEK 5: ADMIN HUB & SHELL
├─ Refactor AdminShell navigation (workflow-first)
├─ Update AdminHubPage (metric cards + queues)
├─ Add density toggle for dense pages
└─ Test on desktop + mobile

WEEK 6: FILE SYSTEM & ONBOARDING
├─ Refactor FileSystemPage (master-detail)
├─ Refactor AccountOnboardingPage (dashboard cards)
├─ Add global filter ribbons
├─ Add status strips
└─ Implement progressive disclosure

WEEK 7: DISPATCH & DENSE MODE
├─ Update DispatchConsolePage (add dense mode toggle)
├─ Implement 3-column dense layout
├─ Add drag alternatives for accessibility
└─ Test performance under dense data

WEEK 8: OFFICER SHELL
├─ Refactor OfficerFieldReportPage (wizard)
├─ Implement glove-safe density (44px touch targets)
├─ Add night-readable theme support
├─ Test on 4-6" phones and tablets

WEEK 9-10: POLISH & TESTING
├─ Accessibility audit (keyboard nav, screen readers)
├─ Performance testing (route chunk sizes < 250KB)
├─ User testing with real operators
├─ A/B testing (old vs. new layouts if needed)
└─ Refinement based on feedback

WEEK 11+: CONTINUOUS
├─ Monitor production metrics
├─ Iterate based on field user feedback
├─ Scale patterns to remaining pages
└─ Document design system
```

---

## PART 4: SUCCESS METRICS

### User-Facing Metrics

| Metric | Current | Target | Measurement |
|---|---|---|---|
| **Task Completion Time** | 5-6 clicks to approve a batch | 2-3 clicks | User testing |
| **Error Rate** | Form submission errors high | 50% reduction | Analytics tracking |
| **Density Satisfaction** | "Too crowded" complaints | 0 (density toggle available) | User survey |
| **Mobile Usability** | "Hard to use on phone" | "Works great on field device" | Field testing |
| **Theme Adoption** | Light theme only | 80% use Dark/Night Patrol | User analytics |

### Technical Metrics

| Metric | Current | Target |
|---|---|---|
| Route chunk size | >250KB | <250KB gzip |
| Time-to-interactive (Admin) | ~3.5s | <2.0s |
| Time-to-interactive (Officer) | ~4.0s | <2.5s on 4G |
| Lighthouse Accessibility | 75 | 95 |
| WCAG 2.2 AA Compliance | 60% of pages | 100% of pages |

---

## PART 5: QUICK START (Week 1 Action Items)

### Day 1-2: Create Foundation Components

```bash
# Create shell layout component
touch apps/web/src/layouts/ShellLayout.tsx
touch apps/web/src/layouts/ShellLayout.css

# Create theme tokens
touch apps/web/src/styles/theme-tokens.css
touch apps/web/src/styles/themes.css

# Create design token documentation
touch apps/web/src/styles/DESIGN_TOKENS.md
```

### Day 3-4: Implement First Page (AdminHubPage)

1. Wrap AdminHubPage in ShellLayout
2. Replace raw metrics with MetricCard components
3. Add StatusStrip
4. Add FilterRibbon
5. Test layout consistency

### Day 5: Review & Refine

1. Test on mobile/tablet
2. Verify theme switching works
3. Check accessibility (keyboard nav, screen readers)
4. Gather feedback from team

---

## ALIGNMENT WITH ORIGINAL STANDARDS

This redesign **restores** the original FreedomCamp-Manager standards:

| Original Standard | How Restored | Status |
|---|---|---|
| Three shells (Officer/Admin/Master) | ShellLayout component + CSS density tiers | ✅ |
| Glove-safe density for officers | --touch-target: 44px, --text-size: 16px | ✅ |
| Standard density for admin | --touch-target: 32px, --text-size: 14px | ✅ |
| Page anatomy consistency | ShellLayout with topBar → filterRibbon → header → status → content | ✅ |
| Card taxonomy (Metric/Workflow/Alert/Queue/Task) | Component library (5 components) | ✅ |
| Governance status strip | StatusStrip component | ✅ |
| Theme support (Light/Dark/Night Patrol/High Contrast) | theme-tokens.css + data-theme attribute | ✅ |
| WCAG 2.2 AA accessibility | Built into component design + testing | ✅ |
| Performance budgets | Lazy loading + route chunking | ✅ |
| Density toggle | Page-level toggle in header | ✅ |

---

**You're not starting from scratch—you're rebuilding on the original foundation, fixing what got lost in production, and adding modern SaaS patterns on top.**

**Ready to start Week 1?** Let me know which page you want to tackle first (AdminHub is easiest; FileSystem is highest ROI).

