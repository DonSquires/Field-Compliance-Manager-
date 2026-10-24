// Extracts counted materials written as "<count> x <item> [@ $<unit price>]"
// from free text, e.g. "14 x .223" or "7 x 7mm @ $3.51". Quantities are never
// inferred: an item is returned only when the text states its count. Which
// detail a material records (calibre or item) comes from its catalog row.

const PRICE = String.raw`(?:\s*@\s*\$?\s*(\d+(?:\.\d+)?))?`;
const CALIBRE = new RegExp(String.raw`(\d+)\s*x\s*(\.\d{2,3}\b|\d{1,2}(?:\.\d+)?\s*mm\b)${PRICE}`, 'gi');
const ITEM = new RegExp(String.raw`(\d+)\s*x\s*([a-z][a-z0-9 .'-]*?)${PRICE}(?=\s*(?:[,;&+)\n]|\band\b|$))`, 'gi');

function extract(pattern, text) {
  return [...String(text ?? '').matchAll(pattern)].map((match) => ({
    detail: match[2].trim().replace(/\s+/g, ' '),
    quantity: Number(match[1]),
    unit_price: match[3] === undefined ? null : Number(match[3]),
  })).filter((item) => item.detail);
}

export function materialsUsed(materialTypeCode, detailFields, text) {
  if (!materialTypeCode) return [];
  const byCalibre = Array.isArray(detailFields) && detailFields.includes('calibre');
  const detailKey = byCalibre ? 'calibre' : 'item';
  return extract(byCalibre ? CALIBRE : ITEM, text).map(({ detail, quantity, unit_price }) => ({
    material_type: materialTypeCode,
    [detailKey]: byCalibre ? detail.replace(/\s+/g, '') : detail,
    quantity,
    unit_price,
  }));
}
