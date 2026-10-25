// Composes a charge code (Source C1 + Subject C2 + Issue C3) from the labels on
// a source row. Numbers, labels and aliases come only from the organisation's
// charge-code catalog rows; this module holds no taxonomy of its own.

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function buildChargeCatalog(rows) {
  const catalog = { source: new Map(), subject: new Map(), issue: new Map(), combos: new Map(), codes: new Map() };
  for (const row of Array.isArray(rows) ? rows : []) {
    const refs = row.external_refs ?? {};
    const component = { charge_source: 'source', charge_subject: 'subject', charge_issue: 'issue' }[row.code_type];
    if (component) {
      for (const alias of [refs.label, ...(Array.isArray(refs.aliases) ? refs.aliases : [])]) {
        if (alias === undefined || alias === null) continue;
        const key = norm(alias);
        const existing = catalog[component].get(key);
        if (existing && existing !== row.code) throw new Error(`Charge ${component} alias "${key}" maps to both ${existing} and ${row.code}`);
        catalog[component].set(key, row.code);
      }
    } else if (row.code_type === 'charge_code') {
      catalog.codes.set(row.code, row);
      for (const alias of Array.isArray(refs.combo_aliases) ? refs.combo_aliases : []) catalog.combos.set(norm(alias), row.code);
    }
  }
  catalog.empty = catalog.codes.size === 0;
  return catalog;
}

export function composeChargeCode({ source, subject, issue }, catalog) {
  if (!catalog || catalog.empty) return {};
  const comboKey = `${norm(source)}|${norm(subject)}|${norm(issue)}`;
  let code = catalog.combos.get(comboKey) ?? null;
  const unresolved = [];
  if (!code) {
    const parts = [['source', source], ['subject', subject], ['issue', issue]].map(([component, label]) => {
      const number = catalog[component].get(norm(label));
      if (number === undefined) unresolved.push({ component, label: String(label ?? '').trim() || null });
      return number;
    });
    if (unresolved.length === 0) code = parts.join('');
  }
  if (!code) {
    return { charge_code: null, charge_code_id: null, charge_code_status: 'unresolved', charge_code_unresolved: unresolved };
  }
  const row = catalog.codes.get(code) ?? null;
  const refs = row?.external_refs ?? {};
  return {
    charge_code: code,
    charge_code_id: row?.id ?? null,
    charge_code_status: row ? 'catalogued' : 'composed',
    charge_code_origin: row ? refs.origin ?? null : 'derived',
    charge_billing_basis: refs.billing_basis ?? null,
    ...(refs.client_gl ? {
      charge_client_gl_code: refs.client_gl.gl_code ?? null,
      charge_client_legacy_account: refs.client_gl.legacy_account ?? null,
    } : {}),
  };
}
