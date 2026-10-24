const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const chargeModule = import('../scripts/patrol-charge-code.mjs');
const materialsModule = import('../scripts/patrol-materials.mjs');

function shippedCatalogRows() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261024233829_rm_charge_code_catalog.sql'), 'utf8');
  const block = sql.match(/\$charge_seed\$([\s\S]*?)\$charge_seed\$/);
  assert.ok(block, 'migration carries a charge_seed block');
  return JSON.parse(block[1]).map((row) => ({ ...row, id: `${row.code_type}:${row.code}` }));
}

test('reproduces every OneFortyOne charge code from its components', async () => {
  const rows = shippedCatalogRows();
  const ofo = rows.filter((row) => row.code_type === 'charge_code' && row.external_refs.origin === 'onefortyone');
  assert.equal(ofo.length, 268, 'the 269-row OneFortyOne list has one duplicate (41535)');
  for (const row of ofo) {
    const { c1, c2, c3 } = row.external_refs;
    assert.equal(`${c1}${c2}${c3}`, row.code);
    assert.ok(['Contract', 'Extra', 'N/A'].includes(row.external_refs.billing_basis), row.code);
  }
  const derived = rows.filter((row) => row.code_type === 'charge_code' && row.external_refs.origin === 'derived');
  assert.ok(derived.length > 0);
  for (const row of derived) assert.equal(row.external_refs.billing_basis, null, `${row.code} has no invented billing basis`);
  const newSubjects = rows.filter((row) => row.code_type === 'charge_subject' && row.external_refs.origin === 'derived');
  const newIssues = rows.filter((row) => row.code_type === 'charge_issue' && row.external_refs.origin === 'derived');
  assert.ok(newSubjects.every((row) => Number(row.code) >= 27));
  assert.ok(newIssues.every((row) => Number(row.code) >= 76));
});

test('composes OneFortyOne, derived, and alias codes from workbook labels', async () => {
  const { buildChargeCatalog, composeChargeCode } = await chargeModule;
  const catalog = buildChargeCatalog(shippedCatalogRows());
  const code = (source, subject, issue) => composeChargeCode({ source, subject, issue }, catalog);
  assert.deepEqual(
    [code('SECURITY', 'Camera', 'Uninstall').charge_code, code('SECURITY', 'Camera', 'Uninstall').charge_code_origin, code('SECURITY', 'Camera', 'Uninstall').charge_billing_basis],
    ['40570', 'onefortyone', 'Contract'],
  );
  assert.equal(code('SECURITY', 'Camera', 'Removal').charge_code, '40570');
  assert.equal(code('PEST CONTROL', 'Camera', 'Removal').charge_code, '30570');
  assert.equal(code('PEST Control', 'Equipment', 'Uninstall').charge_code, '31270');
  assert.equal(code('SECURITY', 'Gates', 'Remove').charge_code, '41461');
  assert.equal(code('SECURITY', 'Sign', 'Installation').charge_code, '42434');
  assert.equal(code('SECURITY', 'Lock', 'Remove').charge_code, '42061');
  assert.equal(code('SECURITY', 'Gate', 'Live').charge_code, code('SECURITY', 'Gate', 'Open').charge_code);
  assert.equal(code('SECURITY', 'Gate', 'Dead').charge_code, code('SECURITY', 'Gate', 'Closed').charge_code);
  assert.equal(code('SECURITY', 'Lock', 'E-Lock maintenance').charge_code, code('SECURITY', 'E-Lock', 'Maintenance').charge_code);
  assert.equal(code('SECURITY', 'Habitat', 'Booking  - R&M').charge_code, code('SECURITY', 'Habitat', 'Booking - company').charge_code);
  assert.equal(code('SECURITY', 'Habitat', 'Booking  - R&M').charge_code_origin, 'onefortyone');
  const reset = code('PEST CONTROL', 'Equipment', 'Reset');
  assert.equal(reset.charge_code_status, 'catalogued');
  assert.equal(reset.charge_code_origin, 'derived');
  assert.equal(reset.charge_billing_basis, null);
});

test('gives each species its own pest code and keeps the real client GL crosswalk', async () => {
  const { buildChargeCatalog, composeChargeCode } = await chargeModule;
  const catalog = buildChargeCatalog(shippedCatalogRows());
  const goat = composeChargeCode({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Goat' }, catalog);
  const pig = composeChargeCode({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Pig' }, catalog);
  const possum = composeChargeCode({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Possum' }, catalog);
  assert.deepEqual([goat.charge_code, goat.charge_client_gl_code, goat.charge_client_legacy_account], ['30132', '3609', '8558-74300-020']);
  assert.deepEqual([pig.charge_code, pig.charge_client_gl_code], ['30151', '3615']);
  assert.deepEqual([possum.charge_code, possum.charge_client_legacy_account], ['30156', '8558-74300-010']);
  const ammo = composeChargeCode({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Ammunition' }, catalog);
  assert.deepEqual([ammo.charge_code, ammo.charge_client_gl_code], ['31204', '3606']);
  const security = composeChargeCode({ source: 'SECURITY', subject: 'Camera', issue: 'Installation' }, catalog);
  assert.equal('charge_client_gl_code' in security, false);
});

test('fails visibly for unresolvable labels and stays silent without a catalog', async () => {
  const { buildChargeCatalog, composeChargeCode } = await chargeModule;
  const catalog = buildChargeCatalog(shippedCatalogRows());
  const mixed = composeChargeCode({ source: 'SECURITY', subject: 'Gates / Signs', issue: 'Gates' }, catalog);
  assert.equal(mixed.charge_code, null);
  assert.equal(mixed.charge_code_status, 'unresolved');
  assert.deepEqual(mixed.charge_code_unresolved, [{ component: 'subject', label: 'Gates / Signs' }]);
  assert.deepEqual(composeChargeCode({ source: 'SECURITY', subject: 'Gate', issue: 'Open' }, buildChargeCatalog([])), {});
  assert.throws(() => buildChargeCatalog([
    { code_type: 'charge_issue', code: '01', external_refs: { label: 'A', aliases: ['x'] } },
    { code_type: 'charge_issue', code: '02', external_refs: { label: 'B', aliases: ['x'] } },
  ]), /maps to both/);
});

test('records ammunition calibre and counts only when the text states them', async () => {
  const { materialsUsed } = await materialsModule;
  assert.deepEqual(materialsUsed('ammunition', ['calibre', 'quantity', 'unit_price'], 'Shot 2 pigs, 14 x .223 and 7 x 7mm @ $3.51'), [
    { material_type: 'ammunition', calibre: '.223', quantity: 14, unit_price: null },
    { material_type: 'ammunition', calibre: '7mm', quantity: 7, unit_price: 3.51 },
  ]);
  assert.deepEqual(materialsUsed('ammunition', ['calibre', 'quantity', 'unit_price'], 'Goat culling, ammunition used'), []);
  assert.deepEqual(materialsUsed('bait_feed', ['item', 'quantity', 'unit_price'], '2 x pig nuts @ $16'), [
    { material_type: 'bait_feed', item: 'pig nuts', quantity: 2, unit_price: 16 },
  ]);
  assert.deepEqual(materialsUsed(null, [], '14 x .223'), []);
});
