# UI/UX Redesign: Presentation-Layer Only (Backend Locked)

**Status:** Design Phase  
**Scope:** Frontend refactoring ONLY  
**Backend:** FROZEN — No schema, RPC, or API changes  
**Date:** 2026-09-12

---

## THE CONSTRAINT

**The backend stays exactly as it is.** No RPC changes, no schema changes, no edge function changes.

The current app's backend works. We're not touching it. We're only redesigning **how data is displayed**.

---

## WHAT CHANGES (Frontend Only)

### ✅ Component Architecture
```
BEFORE:
<FileSystemPage>
  // Fetch batch data via RPC
  // Render each field in a raw HTML table
  // No semantic structure
</FileSystemPage>

AFTER:
<FileSystemPage>
  // Same RPC call (identical signature)
  // Same data response
  // Render using Card components + Progressive Disclosure
  // New semantic structure (master-detail layout)
</FileSystemPage>
```

**The RPC call is unchanged. Only the rendering changes.**

### ✅ Layout & Shells
```
BEFORE:
- Sidebar with 15 items crammed together
- Page anatomy inconsistent per page
- No global filter ribbon
- No status strip

AFTER:
- ShellLayout wrapper (consistent anatomy)
- Navigation reorganized (workflow-first)
- Global filter ribbon on admin pages
- Status strip on all pages
- But... same RPC calls, same data fetching
```

### ✅ Styling & Tokens
```
BEFORE:
- Hard-coded colors throughout pages
- Inconsistent spacing
- No theme support

AFTER:
- CSS variables (--color-*, --spacing-*)
- Theme support (Light/Dark/Night Patrol/High Contrast)
- Consistent typography scale
- But... no data model changes
```

### ✅ Component System
```
BEFORE:
- Raw HTML tables
- Scattered buttons
- No component reuse

AFTER:
- Card components (Metric, Workflow, Queue, Alert, Task)
- Action ribbon pattern
- Master-detail layout
- But... same data being fetched from the same RPCs
```

---

## WHAT STAYS LOCKED (Backend)

### ❌ NO Schema Changes
```
DO NOT change supabase/schema.sql
DO NOT add new tables
DO NOT modify column names or types
DO NOT change foreign keys
```

### ❌ NO RPC Changes
```
DO NOT modify existing RPC signatures
DO NOT add new RPC functions
DO NOT change what RPCs return
DO NOT change RPC parameter names
```

**Example: Current code in FileSystemPage:**
```typescript
// THIS CALL STAYS EXACTLY AS-IS
const { data, error } = await supabase.rpc('get_file_import_batches', {
  limit: 50,
  offset: 0,
});
```

**We can only change how `data` is rendered.**

### ❌ NO Data Model Changes
```
DO NOT change type definitions for RPC responses
DO NOT change what fields are available
DO NOT modify edge function logic
```

### ❌ NO Authentication Changes
```
DO NOT change auth flow
DO NOT modify session handling
DO NOT change role/permission logic
(That's all backend; leave it alone)
```

---

## PRACTICAL EXAMPLES: What's Allowed vs. What's Not

### Example 1: FileSystemPage — Batch Review

**ALLOWED (Frontend Only):**
```tsx
// ✅ Fetch batches using existing RPC (unchanged)
const { data: batches } = await supabase.rpc('get_file_import_batches');

// ✅ Restructure how we render them
function renderBatchQueue() {
  return (
    <MasterDetailLayout
      master={
        <div className="batch-queue">
          {batches.map(batch => (
            <BatchCard 
              key={batch.id}
              batch={batch}
              onClick={() => setSelected(batch.id)}
            />
          ))}
        </div>
      }
      detail={
        selectedBatch && (
          <BatchDetail batch={selectedBatch} />
        )
      }
    />
  );
}

// ✅ Add CSS for new layout
.batch-queue {
  display: grid;
  gap: 8px;
}

.batch-card {
  background: var(--color-bg-tertiary);
  padding: 16px;
  cursor: pointer;
}
```

**NOT ALLOWED (Backend Changes):**
```tsx
// ❌ DO NOT change the RPC to return different data
const { data: batches } = await supabase.rpc('get_file_import_batches_NEW_SIGNATURE');

// ❌ DO NOT add fields to the batch that don't exist in the RPC response
batch.summary = calculateSummary(); // If this requires a new DB call, NO

// ❌ DO NOT modify the batch in the database during display
await supabase.from('file_import_batches').update({...});
```

---

### Example 2: Account Onboarding — Readiness Status

**ALLOWED (Frontend Only):**
```tsx
// ✅ Fetch onboarding data using existing RPC (unchanged)
const { data: queue } = await supabase.rpc('get_crm_onboarding_workspace');

// ✅ Render readiness dimensions as clickable cards with "next step" guidance
function renderReadiness(account) {
  return (
    <div className="readiness-cards">
      {account.readiness.dimensions.map(dim => (
        <ReadinessCard
          key={dim.key}
          status={dim.status}
          label={dim.label}
          nextStep={getNextStepAction(dim)} // Calculated in React, not backend
          onAction={handleNextStep}
        />
      ))}
    </div>
  );
}

// ✅ Add visual emphasis and styling
.readiness-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.readiness-card {
  padding: 16px;
  border-radius: 6px;
  cursor: pointer;
}

.readiness-card--ready {
  background: rgba(46, 204, 113, 0.1);
  border: 1px solid #2ecc71;
}

.readiness-card--blocked {
  background: rgba(230, 126, 34, 0.1);
  border: 1px solid #e67e22;
}
```

**NOT ALLOWED (Backend Changes):**
```tsx
// ❌ DO NOT change the onboarding workspace RPC
const { data } = await supabase.rpc('get_crm_onboarding_workspace_V2');

// ❌ DO NOT add new readiness dimensions that require database queries
account.readiness.dimensions.push({
  key: 'new_dimension',
  status: await supabase.rpc('check_new_thing'), // This is a backend change
});

// ❌ DO NOT update the account status during display
await supabase.from('crm_onboarding_ledger').update({status: 'new'});
```

---

### Example 3: Officer Field Report — Form Wizard

**ALLOWED (Frontend Only):**
```tsx
// ✅ Same form data (same RPC call to submit)
async function submitReport(formData) {
  const { data, error } = await supabase.rpc('submit_officer_field_report', {
    report_type: formData.type,
    severity: formData.severity,
    title: formData.title,
    description: formData.description,
    location_name: formData.location,
    gps_coordinates: formData.gps,
    // ... all fields, unchanged RPC
  });
}

// ✅ Restructure form as multi-step wizard (4 steps)
function OfficerFieldReportPage() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({});

  return (
    <WizardContainer>
      {step === 1 && <Step1_Basics />}
      {step === 2 && <Step2_Location />}
      {step === 3 && <Step3_Details />}
      {step === 4 && <Step4_Review onSubmit={submitReport} />}
    </WizardContainer>
  );
}

// ✅ Add glove-safe sizing for field devices
.wizard-container {
  --touch-target: 44px;
  --text-size: 16px;
  --padding: 16px;
}

.wizard-input {
  width: 100%;
  padding: var(--padding);
  font-size: var(--text-size);
  min-height: var(--touch-target);
}

.wizard-button {
  min-height: var(--touch-target);
  min-width: var(--touch-target);
}
```

**NOT ALLOWED (Backend Changes):**
```tsx
// ❌ DO NOT change the RPC signature
supabase.rpc('submit_officer_field_report_V2', {
  // different parameters
});

// ❌ DO NOT skip required fields
// If a field is required by the RPC, we can't hide it in the UI

// ❌ DO NOT add new RPC calls for wizard steps
// Each step can only use data from the already-fetched context
```

---

## THE DATA PIPELINE (What Stays the Same)

```
┌─────────────────────────────────────────────────────────────────┐
│ LOCKED: Data Fetching Pipeline (Backend)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  React Component                                                │
│        ↓                                                        │
│  useEffect(() => {                                              │
│    supabase.rpc('get_file_import_batches', {...})  ← FROZEN    │
│  })                                                              │
│        ↓                                                        │
│  Supabase Client → Edge Function → Database Query ← FROZEN     │
│        ↓                                                        │
│  Response data: {batches: [...], error: null}     ← FROZEN     │
│        ↓                                                        │
│  setState(data)                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ REDESIGNED: Rendering Pipeline (Frontend Only)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  state.batches (data from RPC above)                            │
│        ↓                                                        │
│  NEW: MasterDetailLayout component (was just a table before)   │
│        ↓                                                        │
│  NEW: BatchCard components (semantic instead of raw HTML)       │
│        ↓                                                        │
│  NEW: BatchDetail panel (progressive disclosure)               │
│        ↓                                                        │
│  NEW: CSS grid layout (breathing room, whitespace)             │
│        ↓                                                        │
│  Rendered UI (same data, better presentation)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**The top pipeline (data fetching) is 100% frozen.**  
**The bottom pipeline (rendering) is completely redesigned.**

---

## FILES THAT CHANGE (Frontend Only)

### Will Be Heavily Refactored
```
apps/web/src/pages/FileSystemPage.tsx          (rendering only)
apps/web/src/pages/FileSystemPage.css          (styling only)
apps/web/src/pages/AccountOnboardingPage.tsx   (rendering only)
apps/web/src/pages/AccountOnboardingPage.css   (styling only)
apps/web/src/pages/OfficerFieldReportPage.tsx  (form structure only)
apps/web/src/pages/OfficerFieldReportPage.css  (styling only)
apps/web/src/shells/AdminShell.tsx             (layout only)
apps/web/src/shells/AdminShell.css             (styling only)
```

### Will Be Created (New)
```
apps/web/src/layouts/ShellLayout.tsx           (layout wrapper)
apps/web/src/layouts/ShellLayout.css           (layout CSS)
apps/web/src/styles/theme-tokens.css           (design tokens)
apps/web/src/styles/themes.css                 (theme variants)
apps/web/src/components/Card/Card.tsx          (card component)
apps/web/src/components/MetricCard/MetricCard.tsx
apps/web/src/components/WorkflowCard/WorkflowCard.tsx
apps/web/src/components/QueueCard/QueueCard.tsx
apps/web/src/components/ActionRibbon/ActionRibbon.tsx
apps/web/src/components/MasterDetailLayout/MasterDetailLayout.tsx
apps/web/src/components/StatusStrip/StatusStrip.tsx
apps/web/src/components/FilterRibbon/FilterRibbon.tsx
```

### Will NOT Change (Backend)
```
supabase/schema.sql                            (FROZEN)
supabase/functions/**/*.ts                     (FROZEN)
backend/src/**/*.ts (if exists)                (FROZEN)
All RPC definitions                            (FROZEN)
All migrations                                 (FROZEN)
```

---

## QUICK CHECKLIST: Before You Change a File

Ask yourself:

1. **Am I changing how data is displayed?** → ✅ OK
2. **Am I changing CSS or layout?** → ✅ OK
3. **Am I adding a new component?** → ✅ OK (if frontend-only)
4. **Am I modifying an RPC signature?** → ❌ STOP
5. **Am I changing the database schema?** → ❌ STOP
6. **Am I changing what data an API returns?** → ❌ STOP
7. **Am I modifying authentication logic?** → ❌ STOP
8. **Am I creating a new backend function?** → ❌ STOP

If you answer "yes" to 1-3 and "no" to 4-8, you're good.

---

## SUMMARY

| Aspect | Status | Details |
|---|---|---|
| **Rewrite page components** | ✅ Go ahead | New layout, new rendering |
| **Create design system** | ✅ Go ahead | Theme tokens, component library |
| **Reorganize navigation** | ✅ Go ahead | Workflow-first sidebar, new shells |
| **Improve accessibility** | ✅ Go ahead | ARIA labels, keyboard nav, color + text |
| **Change backend RPCs** | ❌ STOP | Backend is locked |
| **Modify database schema** | ❌ STOP | Backend is locked |
| **Add edge functions** | ❌ STOP | Backend is locked |
| **Change auth flows** | ❌ STOP | Backend is locked |

**This is a frontend-only transformation. Backend stays exactly as-is.**

