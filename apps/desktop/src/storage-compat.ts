export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function migratePreference(
  storage: PreferenceStorage,
  key: string,
): string | null {
  const current = storage.getItem(`atte.${key}`);
  if (current !== null) return current;
  const legacy = storage.getItem(`crewvane.${key}`);
  if (legacy !== null) storage.setItem(`atte.${key}`, legacy);
  return legacy;
}
