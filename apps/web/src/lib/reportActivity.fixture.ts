// Shared month-end activity report fixture for web tests.
export const activityReportFixture = {
  version: 1,
  basis: 'Entries recorded at the places covered by this agreement.',
  totals: { entries: 6, events: 4, observations: 1, workOrders: 1, patrolVisits: 2, cameraActivations: 0, unattributedEntries: 1, places: 2, travelKm: 19.5, hours: 3.5, photos: 4 },
  categories: [
    { code: 'pest_control', entries: 3, hours: 2, km: 12, photos: 1 },
    { code: 'maintenance', entries: 2, hours: 1.5, km: 7.5, photos: 0 },
    { code: 'vehicle_observation', entries: 1, hours: 0, km: 0, photos: 3 },
  ],
  serviceLines: [{ code: 'none', entries: 1 }],
  byPlace: [{ place: 'Alpha Reserve', entries: 5, hours: 3.5, km: 19.5, photos: 4, categories: { pest_control: 3, maintenance: 2 } }, { place: null, entries: 1, hours: 0, km: 0, photos: 0, categories: {} }],
  pestControl: {
    entries: 3, hours: 2, km: 12,
    bySpecies: [{ code: 'goat', culls: 2, sightings: 1, other: 0, total: 3 }],
    byActivity: [{ code: 'shooting', entries: 2, hours: 1.5 }],
    byEquipment: [{ code: 'dc200', entries: 1 }],
    ammunition: [{ calibre: '.223', entries: 2, rounds: 14 }, { calibre: 'unspecified', entries: 1, rounds: null }],
  },
  maintenance: { entries: 2, hours: 1.5, km: 7.5, bySubject: [{ code: 'gate', entries: 2, hours: 1.5 }], workOrders: { completed: 1, open: 0 } },
  manufacture: { entries: 0, hours: 0, km: 0, bySubject: [], workOrders: { completed: 0, open: 0 } },
  observations: { total: 1, withPhoto: 1, photos: 3, eventPhotos: 1, byModule: [{ module: 'unknown', entries: 1, withPhoto: 1, photos: 3 }] },
  labels: { category: { pest_control: 'Pest control', maintenance: 'Maintenance', vehicle_observation: 'Vehicle observation' }, species: { goat: 'Goat' }, equipment: { dc200: 'DOC 200 trap' }, material: { ammunition: 'Ammunition' } },
  accountedFor: { eventsInScope: 5, mirrorEventsExcluded: 1, activityEvents: 4, observationsInScope: 1, workOrdersInScope: 1, entries: 6, itemised: 6, notItemised: 0, unclassified: 0, reconciled: true },
};
