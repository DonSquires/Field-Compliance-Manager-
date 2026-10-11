import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates, captureEvidencePhoto } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type ActionTaken = 'no_action' | 'verbal_warning' | 'abatement_notice' | 'direction_notice' | 'enforcement_notice' | 'equipment_seized' | 'prosecution_referral';
type NoiseSourceType = 'party' | 'stereo' | 'machinery' | 'industrial' | 'alarm' | 'animal';

export function OfficerNoiseControlPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [noiseSourceAddress, setNoiseSourceAddress] = useState('');
  const [noiseSource, setNoiseSource] = useState<NoiseSourceType>('party');
  const [actionTaken, setActionTaken] = useState<ActionTaken>('no_action');
  const [volumeScore, setVolumeScore] = useState<number>(2);
  const [toneScore, setToneScore] = useState<number>(0);
  const [noticeNumber, setNoticeNumber] = useState('');
  const [complaintAddress, setComplaintAddress] = useState('');
  const [occupantName, setOccupantName] = useState('');
  const [policeRequested, setPoliceRequested] = useState(false);
  const [policePresent, setPolicePresent] = useState(false);
  const [sceneDescription, setSceneDescription] = useState('');
  const [followUpRequired, setFollowUpRequired] = useState(false);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const assessedAt = useRef(new Date().toISOString());

  // Calculate current TDC time score based on current hour
  const getCurrentTimeScore = (): number => {
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 7) return 4; // Night/late night
    if (hour >= 19 || hour < 23) return 3; // Evening
    if (hour >= 7 && hour < 19) return 2;  // Daytime
    return 1;
  };

  const actionNeedsNotice = ['abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized'].includes(actionTaken);

  const valid = Boolean(noiseSourceAddress.trim()) &&
    Boolean(noiseSource) &&
    Boolean(imageBase64) &&
    (!actionNeedsNotice || Boolean(noticeNumber.trim()));

  const pickOrTakePhoto = async (source: 'camera' | 'library') => {
    try {
      const captured = await captureEvidencePhoto(source);
      setImageBase64(captured.base64);
    } catch (err) {
      Alert.alert('Evidence photo error', err instanceof Error ? err.message : 'Photo evidence capture failed.');
    }
  };

  const submit = async () => {
    if (!supabase || !valid) return;
    setBusy(true);
    try {
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }

      const timeScore = getCurrentTimeScore();

      const { data, error } = await supabase.functions.invoke<{
        assessment_id?: string;
        matrix_total?: number;
        classification?: { classification?: string };
        error?: string;
      }>('submit-noise-assessment', {
        body: {
          client_request_id: requestId.current,
          assessed_at: assessedAt.current,
          noise_source: noiseSource,
          noise_source_address: noiseSourceAddress.trim(),
          action_taken: actionTaken,
          volume_score: volumeScore,
          time_score: timeScore,
          tone_score: toneScore,
          complaint_address: complaintAddress.trim() || null,
          notice_number: noticeNumber.trim() || null,
          occupant_name: occupantName.trim() || null,
          police_requested: policeRequested,
          police_present: policePresent,
          scene_description: sceneDescription.trim() || null,
          follow_up_required: followUpRequired,
          shift_id: shiftId,
          gps_lat: coordinates?.lat ?? null,
          gps_lng: coordinates?.lng ?? null,
          image_base64: imageBase64,
        },
      });

      if (error || data?.error || !data?.assessment_id) {
        throw error ?? new Error(data?.error || 'Noise assessment receipt was not confirmed.');
      }

      Alert.alert(
        'Assessment confirmed',
        `Receipt ${data.assessment_id.slice(0, 8)}. Matrix score: ${data.matrix_total ?? (volumeScore + timeScore + toneScore)}. Bob photo candidate: ${data.classification?.classification ?? 'unavailable'}; human review required.`
      );

      setNoiseSourceAddress('');
      setNoticeNumber('');
      setComplaintAddress('');
      setOccupantName('');
      setSceneDescription('');
      setPoliceRequested(false);
      setPolicePresent(false);
      setFollowUpRequired(false);
      setImageBase64(null);
      requestId.current = crypto.randomUUID();
      assessedAt.current = new Date().toISOString();
      setOpen(false);
    } catch (err) {
      Alert.alert('Assessment not confirmed', err instanceof Error ? err.message : 'Noise assessment submission failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}>
        <Text style={styles.triggerText}>{open ? 'Close noise assessment' : 'Noise control assessment'}</Text>
      </Pressable>

      {open && (
        <View style={styles.form}>
          <Text style={styles.title}>Noise Control Assessment</Text>

          <Text style={styles.sectionLabel}>Noise Source Evidence Photo</Text>
          <Text style={styles.helpText}>Required for source/equipment review. A photo cannot measure noise or determine whether it is excessive.</Text>
          <View style={styles.options}>
            <Pressable onPress={() => pickOrTakePhoto('camera')} style={[styles.option, Boolean(imageBase64) && styles.optionActive]}>
              <Text style={styles.optionText}>{imageBase64 ? 'Photo Captured ✓' : 'Take Evidence Photo'}</Text>
            </Pressable>
            <Pressable onPress={() => pickOrTakePhoto('library')} style={styles.option}>
              <Text style={styles.optionText}>Choose from Gallery</Text>
            </Pressable>
          </View>

          <TextInput value={noiseSourceAddress} onChangeText={setNoiseSourceAddress} placeholder="Noise source address *" placeholderTextColor="#718197" style={styles.input} />

          <Text style={styles.sectionLabel}>Noise Source Type</Text>
          <View style={styles.options}>
            {(['party', 'stereo', 'machinery', 'industrial', 'alarm', 'animal'] as NoiseSourceType[]).map((val) => (
              <Pressable key={val} onPress={() => setNoiseSource(val)} style={[styles.option, noiseSource === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Volume Score (0-4)</Text>
          <View style={styles.options}>
            {[0, 1, 2, 3, 4].map((score) => (
              <Pressable key={score} onPress={() => setVolumeScore(score)} style={[styles.option, volumeScore === score && styles.optionActive]}>
                <Text style={styles.optionText}>Score {score}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Tone / Impulsiveness Score (0-2)</Text>
          <View style={styles.options}>
            {[0, 1, 2].map((score) => (
              <Pressable key={score} onPress={() => setToneScore(score)} style={[styles.option, toneScore === score && styles.optionActive]}>
                <Text style={styles.optionText}>Tone {score}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Action Taken</Text>
          <View style={styles.options}>
            {(['no_action', 'verbal_warning', 'abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized', 'prosecution_referral'] as ActionTaken[]).map((val) => (
              <Pressable key={val} onPress={() => setActionTaken(val)} style={[styles.option, actionTaken === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace('_', ' ')}</Text>
              </Pressable>
            ))}
          </View>

          {actionNeedsNotice && (
            <TextInput value={noticeNumber} onChangeText={setNoticeNumber} placeholder="Notice / END Number *" placeholderTextColor="#718197" style={styles.input} />
          )}

          <TextInput value={complaintAddress} onChangeText={setComplaintAddress} placeholder="Complainant address (optional)" placeholderTextColor="#718197" style={styles.input} />
          <TextInput value={occupantName} onChangeText={setOccupantName} placeholder="Occupant / Responsible person name (optional)" placeholderTextColor="#718197" style={styles.input} />
          <TextInput value={sceneDescription} onChangeText={setSceneDescription} placeholder="Scene description / assessment notes" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />

          <View style={styles.options}>
            <Pressable onPress={() => setPoliceRequested((v) => !v)} style={[styles.option, policeRequested && styles.optionActive]}>
              <Text style={styles.optionText}>{policeRequested ? '✓ Police Requested' : 'Request Police'}</Text>
            </Pressable>
            <Pressable onPress={() => setPolicePresent((v) => !v)} style={[styles.option, policePresent && styles.optionActive]}>
              <Text style={styles.optionText}>{policePresent ? '✓ Police Present' : 'Police Present'}</Text>
            </Pressable>
          </View>

          <Pressable onPress={() => setFollowUpRequired((v) => !v)} style={styles.followUp}>
            <Text style={styles.optionText}>{followUpRequired ? '✓ Follow-up required' : 'No follow-up required'}</Text>
          </Pressable>

          <Pressable disabled={!valid || busy} onPress={submit} style={[styles.submit, (!valid || busy) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit Noise Assessment</Text>}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' },
  triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' },
  form: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 },
  title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' },
  sectionLabel: { color: '#88a2b5', fontSize: 12, fontWeight: '700', marginTop: 4 },
  helpText: { color: '#aebdce', fontSize: 12, lineHeight: 17 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { minHeight: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, paddingHorizontal: 9 },
  optionActive: { borderColor: '#7dd3c7', backgroundColor: '#10302e' },
  optionText: { color: '#dce8eb', fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  input: { minHeight: 42, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' },
  textarea: { minHeight: 70 },
  followUp: { minHeight: 38, justifyContent: 'center' },
  submit: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' },
  submitText: { color: '#04211e', fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
