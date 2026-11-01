/**
 * Suggests how a Manufacturing & maintenance job should be classified from the
 * words a person uses to describe it ("fix the lock on the Kaituna gate",
 * "install new signs", "digger work on the track"). The result is only a
 * suggestion: codes come from the organization's reference_codes catalog and
 * the person can always override them before the work order is created.
 */
export type WorkshopJobKind = 'fabrication' | 'maintenance';

export interface WorkshopJobClassification {
  kind: WorkshopJobKind;
  subjectCode: string;
  activityCode: string;
  /** Words that drove the suggestion, shown so the person can see why. */
  matched: string[];
}

interface Rule { code: string; patterns: RegExp[] }

// Order matters: the first matching rule wins, so specific subjects precede general ones.
const SUBJECT_RULES: Rule[] = [
  { code: 'electronic_lock', patterns: [/\be-?lock/, /\belectronic lock/, /\bdigital lock/, /\bkeypad/, /\bsmart lock/] },
  { code: 'physical_lock', patterns: [/\bpadlock/, /\blockbox/, /\block(s|ed)?\b(?! up)/, /\bcombination\b/, /\bkeys?\b/, /\bhasp/] },
  { code: 'gate', patterns: [/\bgates?\b/, /\bbarrier arm/, /\bboom gate/] },
  { code: 'sign', patterns: [/\bsigns?\b/, /\bsignage/, /\bsignboard/] },
  { code: 'camera', patterns: [/\bcameras?\b/, /\bcctv\b/, /\btrail cam/] },
  { code: 'earthworks', patterns: [/\bdigger/, /\bexcavat/, /\bearthworks?/, /\bculverts?/, /\bdrains?\b/, /\bpost holes?/, /\bgrading\b/, /\btrench/] },
  { code: 'pest_device', patterns: [/\btraps?\b/, /\bbait station/, /\bpest device/] },
];

const ACTIVITY_RULES: Rule[] = [
  { code: 'manufacture', patterns: [/\bfabricat/, /\bmanufactur/, /\bweld/, /\bbuild(ing)? (a |an |new )?/, /\bmake (a |an |new )?/] },
  { code: 'uninstall', patterns: [/\bremov/, /\buninstall/, /\btake down/, /\bdismantl/] },
  { code: 'installation', patterns: [/\binstall/, /\berect/, /\bput up/, /\bmount/, /\bfit(ting)? (a |an |new )/] },
  { code: 'maintenance', patterns: [/\brepair/, /\bfix/, /\bmaint(ain|enance)/, /\breplac/, /\bbroken/, /\bdamaged?/, /\bservic(e|ing)/, /\bdig(ger)? work/, /\bexcavat/, /\bclear(ing)?\b/] },
  { code: 'inspection', patterns: [/\binspect/, /\bcheck/, /\bassess/] },
  { code: 'securing', patterns: [/\bsecur/, /\block up/, /\bclose (off|up)/] },
];

const firstMatch = (text: string, rules: Rule[]): { code: string; word: string } | null => {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const hit = text.match(pattern);
      if (hit) return { code: rule.code, word: hit[0].trim() };
    }
  }
  return null;
};

export const classifyWorkshopJob = (description: string): WorkshopJobClassification => {
  const text = description.toLowerCase();
  const subject = firstMatch(text, SUBJECT_RULES);
  const activity = firstMatch(text, ACTIVITY_RULES);
  const activityCode = activity?.code ?? 'maintenance';
  return {
    kind: activityCode === 'manufacture' ? 'fabrication' : 'maintenance',
    subjectCode: subject?.code ?? 'general',
    activityCode,
    matched: [subject?.word, activity?.word].filter((word): word is string => !!word),
  };
};
