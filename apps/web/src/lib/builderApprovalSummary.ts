export interface ApprovalMeaning {
  question: string;
  approveMeans: string;
  rejectMeans: string;
}

export interface PlainPlanSummary {
  problem: string | null;
  outcome: string | null;
  scope: string[];
  whoFor: string[];
  howYouWillCheck: { role: string | null; route: string | null; steps: string[]; result: string | null };
  before: string[];
  during: string[];
  after: string[];
  files: string[];
  questions: string[];
  assumptions: string[];
}

const STOP = 'This job stops and your note is recorded. Ask Bob for a revised job if you want something different. Nothing is merged or deployed.';

const MEANINGS: Record<string, ApprovalMeaning> = {
  specification_review: {
    question: 'Is this the right plan?',
    approveMeans: 'Bob designs and builds this plan on his own branch. Nothing reaches the live app; merge and deployment still need you.',
    rejectMeans: STOP,
  },
  design_review: {
    question: 'Does this design fit the plan?',
    approveMeans: 'Bob builds the screens and code to this design on his own branch.',
    rejectMeans: STOP,
  },
  implementation_review: {
    question: 'Does this implementation satisfy the full approved task?',
    approveMeans: 'The code review is recorded as passed and Bob continues to the next governed step.',
    rejectMeans: STOP,
  },
  security_review: {
    question: 'Are the security findings acceptable?',
    approveMeans: 'Bob continues with the recorded security findings accepted.',
    rejectMeans: STOP,
  },
  release_approval: {
    question: 'Is this ready to become a pull request for release?',
    approveMeans: 'The job is marked ready for release. You still merge the pull request yourself; production deploys only after that merge.',
    rejectMeans: STOP,
  },
};

export function approvalMeaning(type: string): ApprovalMeaning {
  return MEANINGS[type] ?? {
    question: `Do you accept this ${type.replaceAll('_', ' ')}?`,
    approveMeans: 'Bob continues to the next governed step.',
    rejectMeans: STOP,
  };
}

const text = (value: unknown, max = 400) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const list = (value: unknown, pick: (item: unknown) => string | null = item => text(item), max = 8) =>
  Array.isArray(value) ? value.map(pick).filter((item): item is string => Boolean(item)).slice(0, max) : [];
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export interface AcceptanceCoverage {
  supplied: boolean;
  blockers: string[];
}

export function acceptanceCoverage(inputContext: unknown): AcceptanceCoverage {
  const receipt = record(record(inputContext).implementation_acceptance);
  const report = record(receipt.report);
  const requirements = report.requirements;
  const blockers = Array.isArray(report.blockers) ? report.blockers.filter((item): item is string => typeof item === 'string') : [];
  const ids = Array.isArray(requirements) ? requirements.map(item => record(item).requirement_id) : [];
  const exactIds = ids.every(id => typeof id === 'string' && id.trim() !== '' && id.length <= 100)
    && new Set(ids).size === ids.length;
  const supplied = report.version === 1 && report.passed === true && Array.isArray(report.blockers)
    && report.blockers.length === 0 && Array.isArray(requirements) && requirements.length > 0
    && requirements.length <= 100 && exactIds
    && requirements.every(item => record(item).status === 'covered');
  return { supplied, blockers: supplied ? [] : blockers.length ? blockers : [
    'Whole-job acceptance coverage is missing or incomplete. Run to gate to reconcile the task before approving.'
  ] };
}

export function summarizeSpecification(content: string): PlainPlanSummary | null {
  let spec: Record<string, unknown>;
  try { spec = record(JSON.parse(content)); } catch { return null; }
  for (const wrapper of ['validated_output', 'specification', 'product_specification']) {
    if (!spec.product_brief && spec[wrapper] && typeof spec[wrapper] === 'object') spec = record(spec[wrapper]);
  }
  const brief = record(spec.product_brief);
  const acceptance = record(spec.human_acceptance);
  const workflow = record(spec.workflow_verification);
  if (!text(brief.problem) && !text(brief.outcome) && !Array.isArray(spec.delivery_requirements)) return null;
  const files = new Set<string>();
  for (const requirement of Array.isArray(spec.delivery_requirements) ? spec.delivery_requirements : []) {
    for (const file of list(record(requirement).source_scope, item => text(item, 300), 40)) files.add(file);
  }
  return {
    problem: text(brief.problem),
    outcome: text(brief.outcome),
    scope: list(brief.scope),
    whoFor: list(spec.user_roles, item => {
      const role = record(item);
      const name = text(role.role, 80);
      const needs = list(role.needs, need => text(need, 160), 2).join('; ');
      return name ? (needs ? `${name}: ${needs}` : name) : null;
    }, 5),
    howYouWillCheck: {
      role: text(acceptance.role, 80),
      route: text(acceptance.route, 200),
      steps: list(acceptance.steps),
      result: text(acceptance.expected_visible_result),
    },
    before: list(workflow.before, item => text(item, 240), 4),
    during: list(workflow.during, item => text(item, 240), 4),
    after: list(workflow.after, item => text(item, 240), 4),
    files: [...files].slice(0, 20),
    questions: list(spec.unresolved_questions, item => text(item, 300), 6),
    assumptions: list(spec.assumptions, item => text(item, 300), 6),
  };
}
