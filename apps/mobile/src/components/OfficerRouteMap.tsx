import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { StyleSheet, Text, View } from 'react-native';

type Point = [number, number];
type Props = { destinationName: string; destinationAddress: string; coordinates: Point[]; steps: Array<{ instruction: string; distance_meters: number }> };

export function OfficerRouteMap({ destinationName, destinationAddress, coordinates, steps }: Props) {
  const route = coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
  const destination = route.at(-1);
  const origin = route[0];
  if (!origin || !destination) return null;
  const nextStep = steps.find((step) => step.instruction)?.instruction;
  return <View style={styles.wrap}>
    <MapView provider={PROVIDER_GOOGLE} style={styles.map} initialRegion={{ latitude: origin.latitude, longitude: origin.longitude, latitudeDelta: 0.035, longitudeDelta: 0.035 }}>
      <Polyline coordinates={route} strokeColor="#17c7b5" strokeWidth={5} />
      <Marker coordinate={destination} title={destinationName} description={destinationAddress} pinColor="#efb45d" />
    </MapView>
    {nextStep && <Text style={styles.next}>Next: {nextStep}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 7, marginTop: 4 },
  map: { height: 220, borderRadius: 6 },
  next: { color: '#dce8eb', fontSize: 13, fontWeight: '700', lineHeight: 19 },
});