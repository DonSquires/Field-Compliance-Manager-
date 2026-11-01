// Shared client month-end activity report fixture (snapshot version 2) for web tests.
export const activityReportFixture = {
  version: 2,
  itemisedDigest: 'fixture',
  basis: 'Everything recorded at the locations covered by this agreement during the period.',
  totals: { entries: 9, events: 6, observations: 1, workOrders: 1, incidents: 1, patrolVisits: 3, cameraActivations: 1, withNotes: 6, places: 2, photos: 6 },
  categories: [
    { code: 'incident', entries: 1, photos: 2 },
    { code: 'pest_control', entries: 2, photos: 1 },
    { code: 'maintenance', entries: 1, photos: 0 },
    { code: 'camera_activation', entries: 1, photos: 0 },
    { code: 'vehicle_observation', entries: 1, photos: 3 },
    { code: 'patrol_visit', entries: 3, photos: 0 },
  ],
  byPlace: [
    { place: 'Alpha Reserve', entries: 8, photos: 6, categories: { pest_control: 2, patrol_visit: 3, incident: 1, maintenance: 1, vehicle_observation: 1 } },
    { place: null, entries: 1, photos: 0, categories: { camera_activation: 1 } },
  ],
  pestControl: {
    entries: 2,
    bySpecies: [{ code: 'goat', culls: 2, sightings: 1, other: 0, total: 3 }],
    byActivity: [{ code: 'shooting', entries: 2 }],
    byEquipment: [{ code: 'dc200', entries: 1 }],
    ammunition: [{ calibre: '.223', entries: 1, rounds: 14 }, { calibre: 'unspecified', entries: 1, rounds: null }],
  },
  maintenance: { entries: 1, bySubject: [{ code: 'gate', entries: 1 }], workOrders: { completed: 1, open: 0 } },
  manufacture: { entries: 0, bySubject: [], workOrders: { completed: 0, open: 0 } },
  observations: { total: 1, withPhoto: 1, photos: 3, byModule: [{ module: 'unknown', entries: 1, withPhoto: 1, photos: 3 }] },
  incidents: { total: 1, investigations: 1, withMedia: 1, bySeverity: [{ code: 'high', entries: 1 }], byStatus: [{ code: 'in_review', entries: 1 }] },
  labels: {
    category: {
      incident: 'Incidents and investigations', pest_control: 'Pest control', maintenance: 'Maintenance and repairs',
      camera_activation: 'CCTV and camera activity', vehicle_observation: 'Observations', patrol_visit: 'Patrols',
    },
    activity: { shooting: 'Shooting' },
    subject: { gate: 'Gate' },
    species: { goat: 'Goat' },
    equipment: { dc200: 'DOC 200 trap' },
    material: { ammunition: 'Ammunition' },
  },
  accountedFor: {
    eventsInScope: 10, mirrorEventsExcluded: 1, activityEvents: 9, observationsInScope: 1, workOrdersInScope: 1, incidentsInScope: 1,
    entries: 12, reported: 9, operationalWithheld: 3, withheldTravelAdmin: 2, withheldShiftMarkers: 1,
    itemised: 9, notItemised: 0, unclassified: 0, reconciled: true,
  },
};

export const activityLinesFixture = {
  version: 2,
  notItemised: 0,
  lines: [
    {
      d: '2026-09-02', t: '21:40', p: 'Alpha Reserve', k: 'incident', c: 'incident', it: 'trespass', sev: 'high', st: 'in_review',
      n: 'Two people seen cutting the boundary fence near the north gate.', inv: 'INV-2026-014', ivs: 'awaiting_evidence', ph: 2, vid: 1,
      pr: [{ b: 'bob-uploads', p: 'org/incidents/fence-1.jpg' }, { b: 'bob-uploads', p: 'org/incidents/fence-2.jpg' }],
    },
    {
      d: '2026-09-03', t: '06:15', p: 'Alpha Reserve', k: 'event', c: 'pest_control', a: 'shooting', sp: 'goat', ti: 'Pest',
      n: 'Two goats culled on the eastern ridge.', ac: 'Carcasses removed from the track.', ph: 1,
      m: [{ t: 'ammunition', cal: '.223', q: 14 }], pr: [{ b: 'scans', p: 'org/pest/ridge.jpg' }],
    },
    { d: '2026-09-04', p: 'Alpha Reserve', k: 'event', c: 'pest_control', eq: 'dc200', n: 'Trap line checked; no catches.' },
    { d: '2026-09-05', t: '10:00', p: 'Alpha Reserve', k: 'work_order', c: 'maintenance', s: 'gate', j: 'WO-1', ws: 'completed', ti: 'Repair north gate latch', ac: 'Latch replaced and tested.' },
    {
      d: '2026-09-06', t: '14:20', p: 'Alpha Reserve', k: 'observation', c: 'vehicle_observation', mo: 'unknown',
      n: 'Vehicle parked across the service track.', ph: 3,
      pr: [{ b: 'scans', p: 'org/obs/1.jpg' }, { b: 'scans', p: 'org/obs/2.jpg' }, { b: 'scans', p: 'org/obs/3.jpg' }],
    },
    { d: '2026-09-07', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit' },
    { d: '2026-09-09', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit' },
    { d: '2026-09-11', t: '19:05', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit', n: 'Gate found open and secured.' },
    { d: '2026-09-12', t: '02:30', p: null, k: 'event', c: 'camera_activation', n: 'Motion alert reviewed; wildlife only.' },
  ],
};
