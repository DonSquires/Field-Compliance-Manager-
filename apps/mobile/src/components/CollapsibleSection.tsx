import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = { title: string; defaultOpen?: boolean; children: React.ReactNode };

/** Groups related field panels under a named, collapsible header so the officer console isn't one long unlabeled scroll. */
export function CollapsibleSection({ title, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.section}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((current) => !current)} style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.toggle}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 40, borderBottomWidth: 1, borderBottomColor: '#22394a', paddingBottom: 8 },
  title: { color: '#7dd3c7', fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  toggle: { color: '#a7cce7', fontSize: 12, fontWeight: '700' },
  body: { gap: 16 },
});
