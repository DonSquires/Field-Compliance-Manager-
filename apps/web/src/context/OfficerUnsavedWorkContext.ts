import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

type RegisterUnsavedWork = (id: symbol, dirty: boolean) => void;

export const OfficerUnsavedWorkContext = createContext<RegisterUnsavedWork | null>(null);

export function useOfficerUnsavedWork(dirty: boolean) {
  const register = useContext(OfficerUnsavedWorkContext);
  const id = useRef(Symbol('officer-unsaved-work'));

  useEffect(() => {
    const key = id.current;
    register?.(key, dirty);
    return () => register?.(key, false);
  }, [dirty, register]);

  return useCallback(() => register?.(id.current, false), [register]);
}
