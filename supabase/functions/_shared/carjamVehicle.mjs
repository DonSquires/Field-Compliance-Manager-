const BODY_STYLE_NAMES = Object.freeze({
  AT: 'Articulated Truck',
  CC: 'Cab-Chassis only',
  CV: 'Convertible',
  FT: 'Flat Deck Truck',
  HA: 'Hatchback',
  HB: 'Heavy Bus/Service Coach',
  HV: 'Heavy Van',
  LB: 'Minibus',
  LV: 'Light Van',
  MC: 'Motorcycle',
  MM: 'Mobile Machine',
  OR: 'Off Road',
  OT: 'Other Truck',
  SC: 'Self Propelled Caravan',
  SL: 'Saloon',
  SP: 'Sports Car',
  SW: 'Station Wagon',
  TA: 'Tractor',
  TB: 'Boat Trailer',
  TC: 'Caravan',
  TD: 'Domestic Trailer',
  TF: 'Flat Deck Trailer',
  TO: 'Other Commercial Trailer',
  UT: 'Utility',
  XX: 'Unknown',
});

const FUEL_TYPE_NAMES = Object.freeze({
  '1': 'Petrol',
  '01': 'Petrol',
  '2': 'Diesel',
  '02': 'Diesel',
  '3': 'CNG',
  '03': 'CNG',
  '4': 'LPG',
  '04': 'LPG',
  '5': 'Electric',
  '05': 'Electric',
  '6': 'Other',
  '06': 'Other',
  '7': 'Petrol Hybrid',
  '07': 'Petrol Hybrid',
  '8': 'Diesel Hybrid',
  '08': 'Diesel Hybrid',
  '9': 'Petrol Electric Hybrid',
  '09': 'Petrol Electric Hybrid',
  '10': 'Diesel Electric Hybrid',
  '11': 'Plug-in Petrol Hybrid',
  '12': 'Plug-in Diesel Hybrid',
  '13': 'Electric - Petrol Extended',
  '14': 'Electric - Diesel Extended',
  '15': 'Electric Fuel Cell Hydrogen',
  '16': 'Electric Fuel Cell Other',
  '17': 'Plug-in Fuel Cell Hydrogen Hybrid',
  '18': 'Plug-in Fuel Cell Other Hybrid',
  '91': 'Petrol Hybrid',
  '92': 'Plug-in Hybrid-Petrol',
  '93': 'Hybrid',
  '94': 'Diesel Hybrid',
  '95': 'Electric Hybrid',
  '96': 'Plug-in Hybrid-Diesel',
  '97': 'Electric (fuel cell)',
});

export function normalizePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedText(value, maxLength = 120) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function firstObject(value) {
  if (Array.isArray(value)) return value.find((candidate) => candidate && typeof candidate === 'object') ?? null;
  return value && typeof value === 'object' ? value : null;
}

function supportedYear(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}$/.test(text)) return null;
  const year = Number(text);
  const latest = new Date().getUTCFullYear() + 1;
  return year >= 1886 && year <= latest ? year : null;
}

function providerFlag(value) {
  const flag = String(value ?? '').trim().toLowerCase();
  return Boolean(flag) && !['0', 'n', 'no', 'false'].includes(flag);
}

export function parseCarjamBasicResponse(response, requestedPlate) {
  const requested = normalizePlate(requestedPlate);
  if (!/^[A-Z0-9]{1,10}$/.test(requested)) {
    throw new Error('A valid requested plate is required.');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('CarJam returned an invalid JSON response.');
  }

  if ('code' in response && Number(response.code) < 0) {
    throw new Error('CarJam rejected the vehicle query.');
  }

  const message = firstObject(response.message) ?? response;
  const idh = firstObject(message.idh);
  const header = firstObject(idh?.header);
  if (!idh || providerFlag(header?.not_found) || providerFlag(header?.not_assigned)) {
    throw new Error('CarJam did not find the requested vehicle.');
  }

  const vehicle = firstObject(idh.vehicle);
  if (!vehicle) throw new Error('CarJam returned no basic vehicle record.');

  const returnedPlate = normalizePlate(idh.plate ?? vehicle.plate ?? vehicle.registration_plate);
  if (!returnedPlate || returnedPlate !== requested) {
    throw new Error('CarJam returned a different vehicle plate.');
  }

  const bodyCode = normalizedText(vehicle.body_style, 8)?.toUpperCase() ?? null;
  const fuelCode = normalizedText(vehicle.fuel_type, 8) ?? null;
  const parsed = {
    plate: returnedPlate,
    make: normalizedText(vehicle.make),
    model: normalizedText(vehicle.model),
    year: supportedYear(vehicle.year_of_manufacture),
    colour: normalizedText(vehicle.main_colour ?? vehicle.colour),
    body_type: bodyCode ? BODY_STYLE_NAMES[bodyCode] ?? `CarJam body style ${bodyCode}` : null,
    fuel_type: fuelCode ? FUEL_TYPE_NAMES[fuelCode] ?? `CarJam fuel type ${fuelCode}` : null,
  };

  if (!parsed.make && !parsed.model && !parsed.year && !parsed.colour && !parsed.body_type && !parsed.fuel_type) {
    throw new Error('CarJam returned no supported non-personal vehicle attributes.');
  }

  return parsed;
}

export function credentialFreeCarjamSourceUrl(baseUrl, plate) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('plate', normalizePlate(plate));
  url.searchParams.set('basic', '1');
  url.searchParams.set('f', 'json');
  return url.toString();
}
