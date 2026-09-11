export type ActivityEntityKind = 'person' | 'vehicle' | 'animal';
export type ActivityAuthority = 'canonical_reviewed' | 'provisional_similarity';

export type CCTVActivityObservation = {
  id: string;
  kind: ActivityEntityKind;
  observedAt: string;
  canonicalId?: string | null;
  candidateLabel?: string | null;
  plate?: string | null;
  animalType?: string | null;
  embedding?: number[] | null;
  confidence?: number | null;
  reviewState: string;
  siteLabel?: string | null;
  zoneLabel?: string | null;
};

export type CCTVActivityGroup = {
  groupId: string;
  kind: ActivityEntityKind;
  authority: ActivityAuthority;
  label: string;
  firstObservedAt: string;
  lastObservedAt: string;
  visitDates: string[];
  observationCount: number;
  averageConfidence: number | null;
  reviewStates: string[];
  blurb: string;
};

type WorkingGroup = {
  key: string;
  kind: ActivityEntityKind;
  authority: ActivityAuthority;
  label: string;
  observations: CCTVActivityObservation[];
  centroid: number[] | null;
};

function cosineSimilarity(left: number[] | null | undefined, right: number[] | null | undefined): number {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function normalizedPlate(value: string | null | undefined): string | null {
  const plate = value?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
  return plate.length >= 3 ? plate : null;
}

function updateCentroid(group: WorkingGroup, embedding: number[] | null | undefined): void {
  if (!embedding?.length) return;
  if (!group.centroid) {
    group.centroid = [...embedding];
    return;
  }
  const count = group.observations.filter((observation) => observation.embedding?.length === embedding.length).length;
  group.centroid = group.centroid.map((value, index) => (value * Math.max(1, count - 1) + embedding[index]) / Math.max(1, count));
}

function provisionalMatch(groups: WorkingGroup[], observation: CCTVActivityObservation, threshold: number): WorkingGroup | undefined {
  if (observation.kind === 'vehicle') {
    const plate = normalizedPlate(observation.plate);
    if (plate) return groups.find((group) => group.kind === 'vehicle' && group.key === `plate:${plate}`);
  }
  if (!observation.embedding?.length) return undefined;
  return groups
    .filter((group) => group.kind === observation.kind && group.authority === 'provisional_similarity' && group.centroid?.length === observation.embedding?.length)
    .map((group) => ({ group, similarity: cosineSimilarity(group.centroid, observation.embedding) }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity)[0]?.group;
}

function groupBlurb(group: WorkingGroup, dates: string[], place: string): string {
  const noun = group.kind === 'person' ? 'person' : group.kind;
  const repeat = dates.length > 1 ? `across ${dates.length} separate dates` : `on ${dates[0]}`;
  const authority = group.authority === 'canonical_reviewed'
    ? 'linked to a human-reviewed canonical record'
    : 'provisionally grouped by matching visual signals and requiring human confirmation';
  return `${group.observations.length} ${noun} observation${group.observations.length === 1 ? '' : 's'} were recorded ${repeat}${place ? ` at ${place}` : ''}; the activity is ${authority}.`;
}

export function groupCCTVActivity(
  observations: CCTVActivityObservation[],
  options: { similarityThreshold?: number } = {},
): CCTVActivityGroup[] {
  const threshold = options.similarityThreshold ?? 0.86;
  const groups: WorkingGroup[] = [];
  for (const observation of [...observations].sort((left, right) => left.observedAt.localeCompare(right.observedAt))) {
    const canonicalKey = observation.canonicalId ? `${observation.kind}:canonical:${observation.canonicalId}` : null;
    let group = canonicalKey ? groups.find((candidate) => candidate.key === canonicalKey) : provisionalMatch(groups, observation, threshold);
    if (!group) {
      const plate = observation.kind === 'vehicle' ? normalizedPlate(observation.plate) : null;
      const key = canonicalKey || (plate ? `plate:${plate}` : `${observation.kind}:provisional:${groups.length + 1}`);
      group = {
        key,
        kind: observation.kind,
        authority: canonicalKey ? 'canonical_reviewed' : 'provisional_similarity',
        label: observation.candidateLabel || plate || observation.animalType || `Unidentified ${observation.kind}`,
        observations: [],
        centroid: null,
      };
      groups.push(group);
    }
    group.observations.push(observation);
    updateCentroid(group, observation.embedding);
  }

  return groups.map((group, index) => {
    const times = group.observations.map((observation) => observation.observedAt).sort();
    const dates = [...new Set(times.map((value) => value.slice(0, 10)))];
    const confidences = group.observations.map((observation) => observation.confidence).filter((value): value is number => typeof value === 'number');
    const places = [...new Set(group.observations.map((observation) => observation.zoneLabel || observation.siteLabel).filter((value): value is string => Boolean(value)))];
    return {
      groupId: `${group.kind}-${index + 1}`,
      kind: group.kind,
      authority: group.authority,
      label: group.label,
      firstObservedAt: times[0],
      lastObservedAt: times[times.length - 1],
      visitDates: dates,
      observationCount: group.observations.length,
      averageConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      reviewStates: [...new Set(group.observations.map((observation) => observation.reviewState))],
      blurb: groupBlurb(group, dates, places.join(' / ')),
    };
  });
}
