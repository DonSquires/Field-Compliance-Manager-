/**
 * useThermalPrinter — Web Bluetooth transport for ESC/POS bytes built by
 * thermalReceipt.ts.
 *
 * IMPORTANT HARDWARE LIMITATION: Web Bluetooth only speaks BLE GATT. Most
 * inexpensive "infringement ticket" thermal printers use classic Bluetooth
 * SPP (serial port profile), which no browser can reach directly -- there is
 * no web API for classic Bluetooth. Those printers need either a native
 * mobile app / companion bridge, or a WiFi/USB model. This module only
 * supports BLE-capable thermal printers (a growing but not universal class).
 * `isWebBluetoothSupported()` reports API availability, not per-printer
 * compatibility -- a real BLE printer can still fail to expose a writable
 * characteristic this code recognizes; getDiagnostics() surfaces that.
 */

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Splits bytes into BLE-write-safe chunks. Most BLE 4.x controllers cap a single write around 20-512 bytes depending on negotiated MTU; 180 is a conservative default that works broadly without MTU negotiation. */
export function chunkBytes(bytes: Uint8Array, chunkSize = 180): Uint8Array[] {
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks.length ? chunks : [bytes];
}

export type ThermalPrinterStatus = 'idle' | 'connecting' | 'connected' | 'printing' | 'error';

export interface ThermalPrinterDiagnostics {
  deviceName: string | null;
  serviceUuid: string | null;
  characteristicUuid: string | null;
  writeMode: 'write' | 'writeWithoutResponse' | null;
}

/**
 * Holds a live connection to a BLE thermal printer. Construct via
 * connectThermalPrinter(); this class does not attempt to reconnect
 * automatically -- callers should surface disconnects and let the officer
 * retry explicitly (silent reconnect to a nearby device is a safety risk on
 * a shared/public printer).
 */
export class ThermalPrinterConnection {
  private readonly device: BluetoothDevice;
  private readonly characteristic: BluetoothRemoteGATTCharacteristic;
  readonly diagnostics: ThermalPrinterDiagnostics;

  constructor(device: BluetoothDevice, characteristic: BluetoothRemoteGATTCharacteristic, diagnostics: ThermalPrinterDiagnostics) {
    this.device = device;
    this.characteristic = characteristic;
    this.diagnostics = diagnostics;
  }

  get isConnected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const chunks = chunkBytes(bytes);
    for (const chunk of chunks) {
      if (this.diagnostics.writeMode === 'writeWithoutResponse') {
        await this.characteristic.writeValueWithoutResponse(chunk);
      } else {
        await this.characteristic.writeValue(chunk);
      }
      // Small pacing delay so slow printer buffers aren't overrun by back-to-back writes.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  disconnect(): void {
    this.device.gatt?.disconnect();
  }
}

const CANDIDATE_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb', // widely reused by generic ESC/POS BLE thermal printer modules
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // common transparent-UART service (Microchip/RN4677-style modules)
];

/**
 * Requests device access and connects, searching every advertised service
 * for a writable characteristic (many vendors use undocumented UUIDs, so we
 * probe rather than assume one exact UUID). Throws with a clear message on
 * any step so callers can show the officer an actionable error rather than a
 * silent failure.
 */
export async function connectThermalPrinter(): Promise<ThermalPrinterConnection> {
  if (!isWebBluetoothSupported() || !navigator.bluetooth) {
    throw new Error('This browser does not support Web Bluetooth. Use Chrome or Edge on desktop or Android over HTTPS.');
  }
  const bluetooth = navigator.bluetooth;
  const device = await bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: CANDIDATE_SERVICE_UUIDS,
  });
  if (!device.gatt) throw new Error('The selected device does not support a GATT connection.');
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();

  for (const service of services) {
    const characteristics = await service.getCharacteristics();
    for (const characteristic of characteristics) {
      if (characteristic.properties.writeWithoutResponse || characteristic.properties.write) {
        const writeMode: 'write' | 'writeWithoutResponse' = characteristic.properties.writeWithoutResponse ? 'writeWithoutResponse' : 'write';
        return new ThermalPrinterConnection(device, characteristic, {
          deviceName: device.name ?? null,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          writeMode,
        });
      }
    }
  }
  device.gatt.disconnect();
  throw new Error('Connected to the device, but no writable print characteristic was found. This printer may use classic Bluetooth (SPP), which browsers cannot reach.');
}
