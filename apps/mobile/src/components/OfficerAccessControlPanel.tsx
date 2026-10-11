import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates, captureEvidencePhoto } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type EventKind = 'entry_request' | 'exit' | 'credential_check' | 'visitor_arrival' | 'door_security_check';
type SubjectKind = 'person' | 'vehicle' | 'mixed' | 'unknown';
type OfficerDecision = 'admitted' | 'refused' | 'escorted' | 'departed' | 'record_only';
type DecisionBasis =
  | 'credential_present'
  | 'known_person'
  | 'visitor_authorization'
  | 'supervisor_authorization'
  | 'safety_refusal'
  | 'policy_refusal'
  | 'no_decision'
  | 'other';

type RecognitionCandidate = {
  candidate_id: string;
  entity_kind: 'person' | 'vehicle';
  display_name: string;
  score: number;
  basis: string;
  plate_number: string | null;
  reference_thumbnail: string | null;
  last_seen_at: string | null;
};

type RecognitionProbe = {
  probe_id: string;
  probe_kind: 'face' | 'person' | 'vehicle' | 'plate';
  source_variant: 'source' | 'enhanced';
  plate_number: string | null;
  candidates: RecognitionCandidate[];
};

type RecognitionSummary = {
  status?: string;
  classification?: string | null;
  confidence?: number | null;
  reasoning?: string | null;
  failure_reason?: string | null;
  probes?: RecognitionProbe[];
};

type Receipt = {
  eventId: string;
  officerDecision: OfficerDecision;
  evidenceState: string;
  recognitionReviewState: string;
  geofenceStatus: string;
  recognition: RecognitionSummary;
  probeImageUrl: string | null;
};

const label = (value: string) => value.replace(/_/g, ' ');

function RecognitionMatches({
  recognition,
  probeImageUrl,
}: {
  recognition: RecognitionSummary;
  probeImageUrl: string | null;
}) {
  const probes = recognition.probes ?? [];
  return (
    <View accessibilityLabel="Possible recognition matches" style={styles.matches}>
      <Text style={styles.label}>Possible matches</Text>
      {probeImageUrl ? (
        <>
          <Text style={styles.matchCaption}>Input image</Text>
          <Image source={{ uri: probeImageUrl }} accessibilityLabel="Recognition input image" style={styles.probePhoto} />
        </>
      ) : null}
      <Text style={styles.help}>{recognition.reasoning || 'Compare the input with each candidate before deciding what to record.'}</Text>
      {probes.length === 0 ? <Text style={styles.help}>No usable recognition probe was found.</Text> : null}
      {probes.map((probe) => (
        <View key={probe.probe_id} style={styles.probeCard}>
          <Text style={styles.value}>
            {label(probe.probe_kind)}
            {probe.plate_number ? ` · ${probe.plate_number}` : ''}
          </Text>
          <Text style={styles.meta}>{probe.source_variant === 'enhanced' ? 'Deterministically enhanced crop' : 'Original source'}</Text>
          {probe.candidates.length === 0 ? (
            <Text style={styles.help}>No stored record exceeded the configured similarity threshold.</Text>
          ) : probe.candidates.map((candidate) => (
            <View key={`${probe.probe_id}-${candidate.candidate_id}`} style={styles.candidate}>
              {candidate.reference_thumbnail ? (
                <Image
                  source={{ uri: candidate.reference_thumbnail }}
                  accessibilityLabel={`${candidate.display_name} comparison reference`}
                  style={styles.candidatePhoto}
                />
              ) : (
                <View style={styles.candidatePlaceholder}>
                  <Text style={styles.candidatePlaceholderText}>{candidate.entity_kind === 'vehicle' ? 'VEHICLE' : 'PERSON'}</Text>
                </View>
              )}
              <View style={styles.candidateCopy}>
                <Text style={styles.value}>{candidate.display_name}</Text>
                <Text style={styles.meta}>{Math.round(candidate.score * 100)}% similarity · {label(candidate.basis)}</Text>
                {candidate.last_seen_at ? <Text style={styles.meta}>Last seen {new Date(candidate.last_seen_at).toLocaleString()}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.warning}>Discovery candidates are not confirmed identity or permission to enter.</Text>
    </View>
  );
}

export function OfficerAccessControlPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [eventKind, setEventKind] = useState<EventKind>('entry_request');
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('person');
  const [officerDecision, setOfficerDecision] = useState<OfficerDecision>('record_only');
  const [decisionBasis, setDecisionBasis] = useState<DecisionBasis>('no_decision');
  const [claimedIdentity, setClaimedIdentity] = useState('');
  const [credentialReference, setCredentialReference] = useState('');
  const [notes, setNotes] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionPreview, setRecognitionPreview] = useState<RecognitionSummary | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const recognize = async (base64: string) => {
    if (!supabase) return;
    setRecognizing(true);
    setRecognitionPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke<{
        recognition?: RecognitionSummary;
        error?: string;
      }>('recognize-access-subject', { body: { image_base64: base64 } });
      if (error || data?.error || !data?.recognition) {
        throw error ?? new Error(data?.error || 'Recognition returned no candidate receipt.');
      }
      setRecognitionPreview(data.recognition);
    } catch (error) {
      Alert.alert('Recognition unavailable', error instanceof Error ? error.message : 'Possible matches could not be generated.');
    } finally {
      setRecognizing(false);
    }
  };

  const capture = async (source: 'camera' | 'library') => {
    try {
      const photo = await captureEvidencePhoto(source);
      setImageUri(photo.uri);
      setImageBase64(photo.base64);
      await recognize(photo.base64);
    } catch (error) {
      Alert.alert('Evidence unavailable', error instanceof Error ? error.message : 'The photo could not be prepared.');
    }
  };

  const reset = () => {
    setEventKind('entry_request');
    setSubjectKind('person');
    setOfficerDecision('record_only');
    setDecisionBasis('no_decision');
    setClaimedIdentity('');
    setCredentialReference('');
    setNotes('');
    setImageUri(null);
    setImageBase64(null);
    setRecognitionPreview(null);
    requestId.current = crypto.randomUUID();
  };

  const submit = async () => {
    if (!supabase) return;
    setBusy(true);
    try {
      const coordinates = await captureCoordinates();
      if (!coordinates) throw new Error('Current GPS is required to resolve the access-control place.');
      const { data, error } = await supabase.functions.invoke<{
        event_id?: string;
        officer_decision?: OfficerDecision;
        evidence_state?: string;
        recognition_review_state?: string;
        geofence_status?: string;
        recognition?: Receipt['recognition'];
        probe_image_url?: string | null;
        error?: string;
      }>('submit-access-control-event', {
        body: {
          client_request_id: requestId.current,
          observed_at: new Date().toISOString(),
          shift_id: shiftId,
          event_kind: eventKind,
          subject_kind: subjectKind,
          officer_decision: officerDecision,
          decision_basis: decisionBasis,
          claimed_identity: claimedIdentity.trim() || null,
          credential_reference: credentialReference.trim() || null,
          notes: notes.trim() || null,
          gps_lat: coordinates.lat,
          gps_lng: coordinates.lng,
          image_base64: imageBase64,
        },
      });
      if (error || data?.error || !data?.event_id) {
        throw error ?? new Error(data?.error || 'The access-control event was not confirmed.');
      }
      setReceipt({
        eventId: data.event_id,
        officerDecision: data.officer_decision ?? officerDecision,
        evidenceState: data.evidence_state ?? 'not_provided',
        recognitionReviewState: data.recognition_review_state ?? 'not_requested',
        geofenceStatus: data.geofence_status ?? 'not_evaluated',
        recognition: data.recognition ?? { status: 'not_requested' },
        probeImageUrl: data.probe_image_url ?? null,
      });
      reset();
      setOpen(false);
      Alert.alert('Access event confirmed', `Receipt ${data.event_id.slice(0, 8)} was saved.`);
    } catch (error) {
      Alert.alert('Access event not confirmed', error instanceof Error ? error.message : 'Submission failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.trigger}>
        <Text style={styles.triggerText}>{open ? 'Close access control' : receipt ? 'Record another access event' : 'Access control'}</Text>
      </Pressable>

      {receipt && !open ? (
        <View accessibilityLiveRegion="polite" style={styles.receipt}>
          <Text style={styles.kicker}>Event received</Text>
          <Text style={styles.title}>Receipt {receipt.eventId.slice(0, 8)}</Text>
          <View style={styles.authorityCard}>
            <Text style={styles.label}>Officer record</Text>
            <Text style={styles.value}>{label(receipt.officerDecision)}</Text>
            <Text style={styles.help}>This is the operational record. Bob did not change it.</Text>
          </View>
          <View style={styles.bobCard}>
            <Text style={styles.label}>Bob recognition discovery</Text>
            {receipt.recognition.status === 'available' ? (
              <>
                <Text style={styles.value}>
                  {receipt.recognition.classification || 'Visible scene candidate'}
                  {typeof receipt.recognition.confidence === 'number'
                    ? ` · ${Math.round(receipt.recognition.confidence * 100)}% raw field confidence`
                    : ''}
                </Text>
                {receipt.recognition.reasoning ? <Text style={styles.help}>{receipt.recognition.reasoning}</Text> : null}
                <RecognitionMatches recognition={receipt.recognition} probeImageUrl={receipt.probeImageUrl} />
              </>
            ) : (
              <Text style={styles.help}>
                {receipt.recognition.status === 'not_requested'
                  ? 'No photo was submitted, so no machine candidate was created.'
                  : 'Classification was unavailable. No fallback candidate was invented.'}
              </Text>
            )}
            <Text style={styles.warning}>Bob can rank possible matches; only a user can confirm identity, validate a credential, or grant entry.</Text>
          </View>
          <Text style={styles.meta}>
            Place {label(receipt.geofenceStatus)} · Evidence {label(receipt.evidenceState)} · Review {label(receipt.recognitionReviewState)}
          </Text>
        </View>
      ) : null}

      {open ? (
        <View style={styles.form}>
          <Text style={styles.title}>Access event</Text>
          <Text style={styles.help}>Capture a subject, compare possible matches, then record what you did.</Text>

          <Text style={styles.sectionLabel}>Event</Text>
          <View style={styles.options}>
            {(['entry_request', 'exit', 'credential_check', 'visitor_arrival', 'door_security_check'] as EventKind[]).map((value) => (
              <Pressable key={value} onPress={() => setEventKind(value)} style={[styles.option, eventKind === value && styles.optionActive]}>
                <Text style={styles.optionText}>{label(value)}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Subject</Text>
          <View style={styles.options}>
            {(['person', 'vehicle', 'mixed', 'unknown'] as SubjectKind[]).map((value) => (
              <Pressable key={value} onPress={() => setSubjectKind(value)} style={[styles.option, subjectKind === value && styles.optionActive]}>
                <Text style={styles.optionText}>{label(value)}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Officer action</Text>
          <View style={styles.options}>
            {(['admitted', 'refused', 'escorted', 'departed', 'record_only'] as OfficerDecision[]).map((value) => (
              <Pressable key={value} onPress={() => setOfficerDecision(value)} style={[styles.option, officerDecision === value && styles.optionActive]}>
                <Text style={styles.optionText}>{label(value)}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Decision basis</Text>
          <View style={styles.options}>
            {(['credential_present', 'known_person', 'visitor_authorization', 'supervisor_authorization', 'safety_refusal', 'policy_refusal', 'no_decision', 'other'] as DecisionBasis[]).map((value) => (
              <Pressable key={value} onPress={() => setDecisionBasis(value)} style={[styles.option, decisionBasis === value && styles.optionActive]}>
                <Text style={styles.optionText}>{label(value)}</Text>
              </Pressable>
            ))}
          </View>

          <TextInput accessibilityLabel="Claimed identity" value={claimedIdentity} onChangeText={setClaimedIdentity} placeholder="Claimed identity (not verified)" placeholderTextColor="#718197" style={styles.input} />
          <TextInput accessibilityLabel="Credential reference" value={credentialReference} onChangeText={setCredentialReference} placeholder="Badge, permit, pass, or visitor reference" placeholderTextColor="#718197" style={styles.input} />
          <TextInput accessibilityLabel="Access event notes" value={notes} onChangeText={setNotes} placeholder="What was presented, checked, said, and done?" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />

          {imageUri ? <Image source={{ uri: imageUri }} accessibilityLabel="Access-control evidence ready" style={styles.photo} /> : null}
          <View style={styles.options}>
            <Pressable accessibilityRole="button" onPress={() => void capture('camera')} style={styles.option}><Text style={styles.optionText}>{imageUri ? 'Replace photo' : 'Take optional photo'}</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => void capture('library')} style={styles.option}><Text style={styles.optionText}>Choose from gallery</Text></Pressable>
          </View>
          {recognizing ? <View style={styles.recognizing}><ActivityIndicator color="#B91C1C" /><Text style={styles.help}>Finding possible matches...</Text></View> : null}
          {recognitionPreview?.status === 'available' ? (
            <RecognitionMatches recognition={recognitionPreview} probeImageUrl={imageUri} />
          ) : null}
          <Text style={styles.help}>Capture only where site policy and lawful purpose permit. Current GPS is required on submit.</Text>

          <Pressable accessibilityRole="button" onPress={() => void submit()} disabled={busy || recognizing} style={[styles.submit, (busy || recognizing) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Record access event</Text>}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 12, borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', padding: 14, backgroundColor: '#FFFFFF' },
  trigger: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: '#0F172A' },
  triggerText: { color: '#FFFFFF', fontWeight: '800' },
  form: { gap: 12 },
  title: { fontSize: 20, fontWeight: '800', color: '#0F172A' },
  kicker: { fontSize: 11, fontWeight: '800', color: '#475569', textTransform: 'uppercase' },
  sectionLabel: { fontSize: 13, fontWeight: '800', color: '#334155' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { minHeight: 44, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#94A3B8', paddingHorizontal: 12, backgroundColor: '#F8FAFC' },
  optionActive: { borderColor: '#B91C1C', backgroundColor: '#FEE2E2' },
  optionText: { color: '#0F172A', fontWeight: '700' },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#94A3B8', borderRadius: 8, paddingHorizontal: 12, color: '#0F172A', backgroundColor: '#FFFFFF' },
  textarea: { minHeight: 96, paddingTop: 12, textAlignVertical: 'top' },
  photo: { width: '100%', height: 220, borderRadius: 10, backgroundColor: '#E2E8F0' },
  submit: { minHeight: 52, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: '#B91C1C' },
  disabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontWeight: '800' },
  help: { color: '#475569', lineHeight: 20 },
  warning: { color: '#9A3412', fontWeight: '800', lineHeight: 20 },
  recognizing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  matches: { gap: 10, borderRadius: 10, borderWidth: 1, borderColor: '#94A3B8', padding: 12, backgroundColor: '#F8FAFC' },
  matchCaption: { color: '#475569', fontSize: 12, fontWeight: '700' },
  probePhoto: { width: '100%', height: 220, resizeMode: 'contain', borderRadius: 8, backgroundColor: '#0F172A' },
  probeCard: { gap: 8, borderRadius: 8, borderWidth: 1, borderColor: '#CBD5E1', padding: 10, backgroundColor: '#FFFFFF' },
  candidate: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 8, padding: 8, backgroundColor: '#F1F5F9' },
  candidatePhoto: { width: 68, height: 68, borderRadius: 8, backgroundColor: '#CBD5E1' },
  candidatePlaceholder: { width: 68, height: 68, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E2E8F0' },
  candidatePlaceholderText: { color: '#475569', fontSize: 10, fontWeight: '800' },
  candidateCopy: { flex: 1, gap: 2 },
  receipt: { gap: 10 },
  authorityCard: { gap: 6, borderRadius: 10, padding: 12, backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7' },
  bobCard: { gap: 6, borderRadius: 10, padding: 12, backgroundColor: '#FFF7ED', borderWidth: 1, borderColor: '#FDBA74' },
  label: { fontSize: 12, fontWeight: '800', color: '#475569', textTransform: 'uppercase' },
  value: { color: '#0F172A', fontWeight: '800', fontSize: 16 },
  meta: { color: '#475569', fontSize: 12 },
});
