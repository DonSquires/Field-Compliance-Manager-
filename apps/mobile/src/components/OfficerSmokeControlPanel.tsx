import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureEvidencePhoto } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type SmokeSourceType = 'domestic_solid_fuel' | 'industrial' | 'vehicle_exhaust' | 'agricultural' | 'nuisance_burning' | 'unknown';
type ComplaintSource = 'neighbour' | 'council_hotline' | 'self_report' | 'other';
type Severity = 'low' | 'medium' | 'high' | 'critical';
type ActionTaken = 'no_action' | 'verbal_warning' | 'abatement_notice' | 'infringement_notice' | 'prosecution_referral';

export function OfficerSmokeControlPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [complaintAddress, setComplaintAddress] = useState('');
  const [smokeSourceType, setSmokeSourceType] = useState<SmokeSourceType>('domestic_solid_fuel');
  const [complaintSource, setComplaintSource] = useState<ComplaintSource>('neighbour');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [actionTaken, setActionTaken] = useState<ActionTaken>('no_action');
  const [noticeNumber, setNoticeNumber] = useState('');
  const [sceneDescription, setSceneDescription] = useState('');
  const [followUpRequired, setFollowUpRequired] = useState(false);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const assessedAt = useRef(new Date().toISOString());

  const pickOrTakePhoto = async (source: 'camera' | 'library') => {
    try {
      const captured = await captureEvidencePhoto(source);
      setImageBase64(captured.base64);
    } catch (err) {
      Alert.alert('Evidence photo error', err instanceof Error ? err.message : 'Photo evidence capture failed.');
    }
  };

  const actionNeedsNotice = actionTaken === 'abatement_notice' || actionTaken === 'infringement_notice';

  const valid = Boolean(address.trim()) &&
    (!actionNeedsNotice || Boolean(noticeNumber.trim())) &&
    Boolean(imageBase64);

  const submit = async () => {
    if (!supabase || !valid || !imageBase64) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        assessment_id?: string;
        review_state?: string;
        is_out_of_hours?: boolean;
        classification?: { classification?: string };
        error?: string;
      }>('submit-smoke-assessment', {
        body: {
          client_request_id: requestId.current,
          assessed_at: assessedAt.current,
          address: address.trim(),
          complaint_address: complaintAddress.trim() || null,
          smoke_source_type: smokeSourceType,
          complaint_source: complaintSource,
          severity: severity,
          action_taken: actionTaken,
          notice_number: noticeNumber.trim() || null,
          scene_description: sceneDescription.trim() || null,
          follow_up_required: followUpRequired,
          shift_id: shiftId,
          image_base64: imageBase64,
        },
      });

      if (error || data?.error || !data?.assessment_id) {
        throw error ?? new Error(data?.error || 'Smoke assessment was not confirmed.');
      }

      Alert.alert(
        'Assessment confirmed',
        `Receipt ${data.assessment_id.slice(0, 8)}. Review state: ${data.review_state ?? 'submitted'}.${
          data.is_out_of_hours ? ' Out-of-hours coverage.' : ''
        }`
      );

      setAddress('');
      setComplaintAddress('');
      setNoticeNumber('');
      setSceneDescription('');
      setFollowUpRequired(false);
      setImageBase64(null);
      requestId.current = crypto.randomUUID();
      assessedAt.current = new Date().toISOString();
      setOpen(false);
    } catch (err) {
      Alert.alert('Assessment not confirmed', err instanceof Error ? err.message : 'Smoke assessment submission failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}>
        <Text style={styles.triggerText}>{open ? 'Close smoke assessment' : 'Smoke complaint assessment'}</Text>
      </Pressable>

      {open && (
        <View style={styles.form}>
          <Text style={styles.title}>Smoke Complaint Assessment</Text>

          <Text style={styles.sectionLabel}>Smoke Evidence Photo</Text>
          <View style={styles.options}>
            <Pressable onPress={() => pickOrTakePhoto('camera')} style={[styles.option, Boolean(imageBase64) && styles.optionActive]}>
              <Text style={styles.optionText}>{imageBase64 ? 'Photo Captured ✓' : 'Take Evidence Photo'}</Text>
            </Pressable>
            <Pressable onPress={() => pickOrTakePhoto('library')} style={styles.option}>
              <Text style={styles.optionText}>Choose from Gallery</Text>
            </Pressable>
          </View>

          <TextInput value={address} onChangeText={setAddress} placeholder="Observed smoke address *" placeholderTextColor="#718197" style={styles.input} />
          <TextInput value={complaintAddress} onChangeText={setComplaintAddress} placeholder="Complainant address (if different)" placeholderTextColor="#718197" style={styles.input} />

          <Text style={styles.sectionLabel}>Smoke Source Type</Text>
          <View style={styles.options}>
            {(['domestic_solid_fuel', 'industrial', 'vehicle_exhaust', 'agricultural', 'nuisance_burning', 'unknown'] as SmokeSourceType[]).map((val) => (
              <Pressable key={val} onPress={() => setSmokeSourceType(val)} style={[styles.option, smokeSourceType === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace(/_/g, ' ')}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Complaint Source</Text>
          <View style={styles.options}>
            {(['neighbour', 'council_hotline', 'self_report', 'other'] as ComplaintSource[]).map((val) => (
              <Pressable key={val} onPress={() => setComplaintSource(val)} style={[styles.option, complaintSource === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace(/_/g, ' ')}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Severity</Text>
          <View style={styles.options}>
            {(['low', 'medium', 'high', 'critical'] as Severity[]).map((val) => (
              <Pressable key={val} onPress={() => setSeverity(val)} style={[styles.option, severity === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Action Taken</Text>
          <View style={styles.options}>
            {(['no_action', 'verbal_warning', 'abatement_notice', 'infringement_notice', 'prosecution_referral'] as ActionTaken[]).map((val) => (
              <Pressable key={val} onPress={() => setActionTaken(val)} style={[styles.option, actionTaken === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace(/_/g, ' ')}</Text>
              </Pressable>
            ))}
          </View>

          {actionNeedsNotice && (
            <TextInput value={noticeNumber} onChangeText={setNoticeNumber} placeholder="Abatement / Infringement Notice number *" placeholderTextColor="#718197" style={styles.input} />
          )}

          <TextInput value={sceneDescription} onChangeText={setSceneDescription} placeholder="Scene description / visibility / smell notes" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />

          <Pressable onPress={() => setFollowUpRequired((v) => !v)} style={styles.followUp}>
            <Text style={styles.optionText}>{followUpRequired ? '✓ Follow-up required' : 'No follow-up required'}</Text>
          </Pressable>

          <Pressable disabled={!valid || busy} onPress={submit} style={[styles.submit, (!valid || busy) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit Smoke Assessment</Text>}
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
