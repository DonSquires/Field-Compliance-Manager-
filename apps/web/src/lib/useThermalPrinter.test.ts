import { describe, expect, it } from 'vitest';
import { chunkBytes, isWebBluetoothSupported } from './useThermalPrinter';

describe('chunkBytes', () => {
  it('splits bytes into chunks no larger than the requested size', () => {
    const bytes = new Uint8Array(500).map((_, index) => index % 256);
    const chunks = chunkBytes(bytes, 180);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(180);
    expect(chunks[1].length).toBe(180);
    expect(chunks[2].length).toBe(140);
  });

  it('returns the original bytes as a single chunk when smaller than chunkSize', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const chunks = chunkBytes(bytes, 180);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes);
  });

  it('preserves byte order and values across chunk boundaries', () => {
    const bytes = new Uint8Array(400).map((_, index) => index % 256);
    const chunks = chunkBytes(bytes, 100);
    const reassembled = new Uint8Array(bytes.length);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    expect(reassembled).toEqual(bytes);
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkBytes(new Uint8Array([1]), 0)).toThrow();
  });
});

describe('isWebBluetoothSupported', () => {
  it('reports false in a test environment without navigator.bluetooth', () => {
    expect(isWebBluetoothSupported()).toBe(false);
  });
});
