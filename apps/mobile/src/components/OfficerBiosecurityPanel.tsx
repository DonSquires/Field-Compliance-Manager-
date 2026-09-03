import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureEvidencePhoto } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type DensityEstimate = 'isolated' | 'scattered' | 'moderate' | 'dense' | 'severe' | 'not_found';
type ActionTaken = 'no_action' | 'advisory_notice' | 'notice_of_direction' | 'infringement_notice' | 'mpi_referral';

export function OfficerBiosecurityPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [speciesName, setSpeciesName] = useState('');
  const [densityEstimate, setDensityEstimate] = useState<DensityEstimate>('scattered');
  const [actionTaken, setActionTaken] = useState<ActionTaken>('no_action');
  const [locationName, setLocationName] = useState('');
  const [protectedLandAddress, setProtectedLandAddress] = useState('');
  const [noticeNumber, setNoticeNumber] = useState('');
  const [mpiReferralNumber, setMpiReferralNumber] = useState('');
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

  const actionNeedsNotice = actionTaken === 'notice_of_direction' || actionTaken === 'infringement_notice';
  const actionNeedsReferral = actionTaken === 'mpi_referral';

  const valid = Boolean(locationName.trim()) &&
    (densityEstimate === 'not_found' || Boolean(speciesName.trim())) &&
    (!actionNeedsNotice || Boolean(noticeNumber.trim())) &&
    (!actionNeedsReferral || Boolean(mpiReferralNumber.trim())) &&
    Boolean(imageBase64);

  const submit = async () => {
    if (!supabase || !valid || !imageBase64) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        assessment_id?: string;
        review_state?: string;
        classification?: { classification?: string };
        error?: string;
      }>('submit-biosecurity-assessment', {
        body: {
          client_request_id: requestId.current,
          assessed_at: assessedAt.current,
          species_name: speciesName.trim() || null,
          density_estimate: densityEstimate,
          action_taken: actionTaken,
          scene_description: sceneDescription.trim() || null,
          location_name: locationName.trim(),
          protected_land_address: protectedLandAddress.trim() || null,
          notice_number: noticeNumber.trim() || null,
          mpi_referral_number: mpiReferralNumber.trim() || null,
          follow_up_required: followUpRequired,
          shift_id: shiftId,
          image_base64: imageBase64,
        },
      });

      if (error || data?.error || !data?.assessment_id) {
        throw error ?? new Error(data?.error || 'Biosecurity assessment was not confirmed.');
      }

      Alert.alert(
        'Assessment confirmed',
        `Receipt ${data.assessment_id.slice(0, 8)}. Review state: ${data.review_state ?? 'submitted'}.`
      );

      setSpeciesName('');
      setLocationName('');
      setProtectedLandAddress('');
      setNoticeNumber('');
      setMpiReferralNumber('');
      setSceneDescription('');
      setFollowUpRequired(false);
      setImageBase64(null);
      requestId.current = crypto.randomUUID();
      assessedAt.current = new Date().toISOString();
      setOpen(false);
    } catch (err) {
      Alert.alert('Assessment not confirmed', err instanceof Error ? err.message : 'Assessment submission failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}>
        <Text style={styles.triggerText}>{open ? 'Close biosecurity assessment' : 'Biosecurity assessment'}</Text>
      </Pressable>

      {open && (
        <View style={styles.form}>
          <Text style={styles.title}>Biosecurity Assessment</Text>

          <Text style={styles.sectionLabel}>Pest Evidence Photo</Text>
          <View style={styles.options}>
            <Pressable onPress={() => pickOrTakePhoto('camera')} style={[styles.option, Boolean(imageBase64) && styles.optionActive]}>
              <Text style={styles.optionText}>{imageBase64 ? 'Photo Captured ✓' : 'Take Evidence Photo'}</Text>
            </Pressable>
            <Pressable onPress={() => pickOrTakePhoto('library')} style={styles.option}>
              <Text style={styles.optionText}>Choose from Gallery</Text>
            </Pressable>
          </View>

          <TextInput value={locationName} onChangeText={setLocationName} placeholder="Observed location name *" placeholderTextColor="#718197" style={styles.input} />
          <TextInput value={speciesName} onChangeText={setSpeciesName} placeholder="Pest/Species name *" placeholderTextColor="#718197" style={styles.input} />
          <TextInput value={protectedLandAddress} onChangeText={setProtectedLandAddress} placeholder="Protected land address (if different)" placeholderTextColor="#718197" style={styles.input} />

          <Text style={styles.sectionLabel}>Density Estimate</Text>
          <View style={styles.options}>
            {(['isolated', 'scattered', 'moderate', 'dense', 'severe', 'not_found'] as DensityEstimate[]).map((val) => (
              <Pressable key={val} onPress={() => setDensityEstimate(val)} style={[styles.option, densityEstimate === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace('_', ' ')}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Action Taken</Text>
          <View style={styles.options}>
            {(['no_action', 'advisory_notice', 'notice_of_direction', 'infringement_notice', 'mpi_referral'] as ActionTaken[]).map((val) => (
              <Pressable key={val} onPress={() => setActionTaken(val)} style={[styles.option, actionTaken === val && styles.optionActive]}>
                <Text style={styles.optionText}>{val.replace('_', ' ')}</Text>
              </Pressable>
            ))}
          </View>

          {actionNeedsNotice && (
            <TextInput value={noticeNumber} onChangeText={setNoticeNumber} placeholder="Notice number *" placeholderTextColor="#718197" style={styles.input} />
          )}

          {actionNeedsReferral && (
            <TextInput value={mpiReferralNumber} onChangeText={setMpiReferralNumber} placeholder="MPI referral number *" placeholderTextColor="#718197" style={styles.input} />
          )}

          <TextInput value={sceneDescription} onChangeText={setSceneDescription} placeholder="Scene description / notes" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} />

          <Pressable onPress={() => setFollowUpRequired((v) => !v)} style={styles.followUp}>
            <Text style={styles.optionText}>{followUpRequired ? '✓ Follow-up required' : 'No follow-up required'}</Text>
          </Pressable>

          <Pressable disabled={!valid || busy} onPress={submit} style={[styles.submit, (!valid || busy) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit Assessment</Text>}
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
