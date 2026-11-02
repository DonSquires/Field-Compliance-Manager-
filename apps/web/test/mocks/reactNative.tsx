import type { ReactNode } from 'react';
import { vi } from 'vitest';

type Children = { children?: ReactNode };

export const View = ({ children }: Children) => <div>{children}</div>;
export const Text = ({ children }: Children) => <span>{children}</span>;
export const ActivityIndicator = () => <span>Loading</span>;
export const Pressable = ({ children, disabled, onPress, accessibilityLabel }: Children & { disabled?: boolean; onPress?: () => void; accessibilityLabel?: string }) =>
  <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>;
export const TextInput = ({ value, onChangeText, placeholder, accessibilityLabel, editable }: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
  editable?: boolean;
}) => <input aria-label={accessibilityLabel} disabled={editable === false} value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)} />;
export const StyleSheet = { create: <T,>(styles: T): T => styles };
export const Alert = { alert: vi.fn() };
