const normalized = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

function conditionMatches(input, condition) {
  if (!['subject', 'issue', 'description', 'source'].includes(condition.field)) throw new Error(`Unsupported classification field: ${condition.field}`);
  const value = normalized(input[condition.field]);
  if (condition.operator === 'non_empty') return value.length > 0;
  if (condition.operator === 'exact') return value === normalized(condition.value);
  if (condition.operator === 'in') return Array.isArray(condition.values) && condition.values.some((candidate) => value === normalized(candidate));
  if (condition.operator === 'contains') return value.includes(normalized(condition.value));
  if (condition.operator === 'regex') return new RegExp(String(condition.value), 'i').test(value);
  throw new Error(`Unsupported classification operator: ${condition.operator}`);
}

function firstMatch(input, rules, codeType) {
  return [...rules]
    .filter((rule) => rule.target_code_type === codeType && rule.active !== false)
    .sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100))
    .find((rule) => Array.isArray(rule.conditions) && rule.conditions.length > 0 && rule.conditions.every((condition) => conditionMatches(input, condition))) ?? null;
}

export function classifyPatrolWork({ subject, issue, description, source }, rules) {
  if (!Array.isArray(rules)) throw new Error('Classification rules must be loaded from the work catalog');
  const input = { subject, issue, description, source };
  const subjectRule = firstMatch(input, rules, 'work_subject');
  const activityRule = firstMatch(input, rules, 'work_activity');
  const speciesRule = firstMatch(input, rules, 'biosecurity_species');
  return {
    work_subject_code_id: subjectRule?.target_code_id ?? null,
    work_subject_code: subjectRule?.target_code ?? null,
    work_activity_code_id: activityRule?.target_code_id ?? null,
    work_activity_code: activityRule?.target_code ?? null,
    ...(speciesRule ? {
      biosecurity_species_code_id: speciesRule.target_code_id ?? null,
      biosecurity_species_code: speciesRule.target_code ?? null,
    } : {}),
    work_order_candidate: activityRule?.target_external_refs?.work_order_candidate === true,
    classification_rule_ids: [subjectRule?.id, activityRule?.id, speciesRule?.id].filter(Boolean),
  };
}