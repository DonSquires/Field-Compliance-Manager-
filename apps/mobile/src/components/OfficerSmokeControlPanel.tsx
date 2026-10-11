import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureEvidencePhoto } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type SmokeSourceType = 'domestic_solid_fuel' | 'industrial' | 'vehicle_exhaust' | 'agricultural' | 'nuisance_burning' | 'unknown';
type ComplaintSource = 'neighbour' | 'council_hotline' | 'self_report' | 'other';
type Severity = 'low' | 'moderate' | 'high' | 'critical';
type ActionTaken = 'no_action' | 'verbal_warning' | 'abatement_notice' | 'infringement_notice' | 'prosecution_referral';

export function OfficerSmokeControlPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [complaintAddress, setComplaintAddress] = useState('');
  const [smokeSourceType, setSmokeSourceType] = useState<SmokeSourceType>('domestic_solid_fuel');
  const [complaintSource, setComplaintSource] = useState<ComplaintSource>('neighbour');
  const [severity, setSeverity] = useState<Severity>('moderate');
  const [actionTaken, setActionTaken] = useState<ActionTaken>('no_action');
  const [noticeNumber, setNoticeNumber] = useState('');
  const [sceneDescription, setSceneDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [followUpRequired, setFollowUpRequired] = useState(false);
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageCapturedAt, setImageCapturedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const assessedAt = useRef<string | null>(null);

  const pickOrTakePhoto = async (source: 'camera' | 'library') => {
    try {
      const captured = await captureEvidencePhoto(source);
      const capturedAt = new Date().toISOString();
      setImageUri(captured.uri);
      setImageBase64(captured.base64);
      setImageCapturedAt(capturedAt);
      setSourceConfirmed(false);
      assessedAt.current = capturedAt;
    } catch (err) {
      Alert.alert('Evidence photo error', err instanceof Error ? err.message : 'Photo evidence capture failed.');
    }
  };

  const actionNeedsNotice = actionTaken === 'abatement_notice' || actionTaken === 'infringement_notice';
  const canConfirmSource = Boolean(address.trim()) && Boolean(imageBase64);

  const valid = Boolean(address.trim()) &&
    Boolean(sceneDescription.trim()) &&
    (!actionNeedsNotice || Boolean(noticeNumber.trim())) &&
    sourceConfirmed &&
    Boolean(imageBase64) &&
    Boolean(assessedAt.current);
  const outstanding = [
    !address.trim() && 'observed address',
    !sceneDescription.trim() && 'scene description',
    !sourceConfirmed && 'source confirmation',
    !imageBase64 && 'evidence photo',
    actionNeedsNotice && !noticeNumber.trim() && 'notice number',
  ].filter(Boolean) as string[];

  const submit = async () => {
    if (!supabase || !valid || !imageBase64 || !assessedAt.current) return;
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
          notes: notes.trim() || null,
          follow_up_required: followUpRequired,
          source_confirmed: sourceConfirmed,
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
        }${data.classification?.classification ? ` Bob candidate: ${data.classification.classification}; human review required.` : ' Photo classification unavailable; human review required.'}`
      );

      setAddress('');
      setComplaintAddress('');
      setNoticeNumber('');
      setSceneDescription('');
      setNotes('');
      setFollowUpRequired(false);
      setSourceConfirmed(false);
      setImageUri(null);
      setImageBase64(null);
      setImageCapturedAt(null);
      requestId.current = crypto.randomUUID();
      assessedAt.current = null;
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
          <Text style={styles.helpText}>
            Required supporting evidence. Bob may describe visible smoke or a possible source, but cannot establish a breach, legal basis, notice, or enforcement action.
          </Text>
          {imageUri && (
            <View style={styles.photoReceipt}>
              <Image source={{ uri: imageUri }} accessibilityLabel="Captured smoke evidence" style={styles.photoPreview} />
              <View style={styles.photoReceiptText}>
                <Text style={styles.photoReceiptTitle}>Evidence photo ready</Text>
                <Text style={styles.photoTimestamp}>
                  Captured {imageCapturedAt ? new Date(imageCapturedAt).toLocaleString() : 'just now'}
                </Text>
                <Text style={styles.helpText}>It will be watermarked, hashed, and stored privately when submitted.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove captured smoke evidence"
                onPress={() => {
                  setImageUri(null);
                  setImageBase64(null);
                  setImageCapturedAt(null);
                  setSourceConfirmed(false);
                  assessedAt.current = null;
                }}
                style={styles.removePhoto}
              >
                <Text style={styles.removePhotoText}>Remove</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.options}>
            <Pressable accessibilityRole="button" onPress={() => pickOrTakePhoto('camera')} style={[styles.option, Boolean(imageBase64) && styles.optionActive]}>
              <Text style={styles.optionText}>{imageBase64 ? 'Replace with Camera' : 'Take Evidence Photo'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => pickOrTakePhoto('library')} style={styles.option}>
              <Text style={styles.optionText}>{imageBase64 ? 'Replace from Gallery' : 'Choose from Gallery'}</Text>
            </Pressable>
          </View>

          <TextInput
            accessibilityLabel="Observed smoke address"
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              setSourceConfirmed(false);
            }}
            placeholder="Observed smoke address *"
            placeholderTextColor="#718197"
            style={styles.input}
          />
          <TextInput accessibilityLabel="Complainant address" value={complaintAddress} onChangeText={setComplaintAddress} placeholder="Complainant address (if different)" placeholderTextColor="#718197" style={styles.input} />

          <Text style={styles.sectionLabel}>Smoke Source Type</Text>
          <View style={styles.options}>
            {(['domestic_solid_fuel', 'industrial', 'vehicle_exhaust', 'agricultural', 'nuisance_burning', 'unknown'] as SmokeSourceType[]).map((val) => (
              <Pressable
                key={val}
                onPress={() => {
                  setSmokeSourceType(val);
                  setSourceConfirmed(false);
                }}
                style={[styles.option, smokeSourceType === val && styles.optionActive]}
              >
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
            {(['low', 'moderate', 'high', 'critical'] as Severity[]).map((val) => (
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
            <TextInput accessibilityLabel="Notice number" value={noticeNumber} onChangeText={setNoticeNumber} placeholder="Abatement / Infringement Notice number *" placeholderTextColor="#718197" style={styles.input} />
          )}

          <TextInput accessibilityLabel="Scene description" value={sceneDescription} onChangeText={setSceneDescription} placeholder="Scene description / visibility / smell *" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />
          <TextInput accessibilityLabel="Officer notes" value={notes} onChangeText={setNotes} placeholder="Officer notes / context for supervisor" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />

          <Text style={styles.helpText}>
            {canConfirmSource
              ? 'Confirm only when you personally established the visible source at this place and the photo represents that observation.'
              : 'Enter the observed address and capture its evidence photo before confirming the source.'}
          </Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: sourceConfirmed, disabled: !canConfirmSource }}
            disabled={!canConfirmSource}
            onPress={() => setSourceConfirmed((value) => !value)}
            style={[styles.followUp, sourceConfirmed && styles.optionActive, !canConfirmSource && styles.disabled]}
          >
            <Text style={styles.optionText}>{sourceConfirmed ? 'Observed source confirmed ✓' : 'Confirm the observed source at this place'}</Text>
          </Pressable>

          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: followUpRequired }} onPress={() => setFollowUpRequired((v) => !v)} style={[styles.followUp, followUpRequired && styles.optionActive]}>
            <Text style={styles.optionText}>{followUpRequired ? '✓ Follow-up required' : 'No follow-up required'}</Text>
          </Pressable>

          {!valid && (
            <Text accessibilityLiveRegion="polite" style={styles.requirements}>
              Still needed: {outstanding.join(', ')}.
            </Text>
          )}
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !valid || busy }} disabled={!valid || busy} onPress={submit} style={[styles.submit, (!valid || busy) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit Smoke Assessment</Text>}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  trigger: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' },
  triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' },
  form: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 },
  title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' },
  sectionLabel: { color: '#88a2b5', fontSize: 12, fontWeight: '700', marginTop: 4 },
  helpText: { color: '#aebdce', fontSize: 12, lineHeight: 17 },
  photoReceipt: { gap: 9, borderWidth: 1, borderColor: '#3a5364', borderRadius: 8, backgroundColor: '#07111b', padding: 9 },
  photoPreview: { width: '100%', height: 180, borderRadius: 6, backgroundColor: '#02070b', resizeMode: 'cover' },
  photoReceiptText: { gap: 3 },
  photoReceiptTitle: { color: '#eef6f7', fontSize: 13, fontWeight: '800' },
  photoTimestamp: { color: '#85c7bd', fontSize: 11, fontWeight: '700' },
  removePhoto: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#8f6570', borderRadius: 5 },
  removePhotoText: { color: '#f1c7cf', fontSize: 12, fontWeight: '800' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, paddingHorizontal: 11 },
  optionActive: { borderColor: '#7dd3c7', backgroundColor: '#10302e' },
  optionText: { color: '#dce8eb', fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  input: { minHeight: 42, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' },
  textarea: { minHeight: 70 },
  followUp: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, paddingHorizontal: 11 },
  requirements: { color: '#f2c979', fontSize: 12, lineHeight: 17 },
  submit: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' },
  submitText: { color: '#04211e', fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
