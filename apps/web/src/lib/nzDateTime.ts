const nzParts = (date: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(date).reduce<Record<string, string>>((parts, part) => {
  if (part.type !== 'literal') parts[part.type] = part.value;
  return parts;
}, {});

export const nzDateInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = nzParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export const fromNzDateInput = (value: string, original?: string | null) => {
  if (!value) return null;
  if (original && nzDateInput(original) === value) return new Date(original).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Invalid New Zealand date and time.');
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = nzParts(new Date(instant));
    const displayed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    instant += target - displayed;
  }
  const resolved = new Date(instant).toISOString();
  if (nzDateInput(resolved) !== value) throw new Error('This local date/time does not exist in Pacific/Auckland. Check the calendar date and daylight-saving change.');
  if ([instant - 3600000, instant + 3600000].some((candidate) => nzDateInput(new Date(candidate).toISOString()) === value)) {
    throw new Error('This local time occurs twice when daylight saving ends. Keep the recorded time, or ask payroll to resolve the UTC offset before correcting it.');
  }
  return resolved;
};
