export const parseJsonSafe = <T>({ value, fallback }: { value: string | null | undefined; fallback: T }): T => {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const stringifyJson = ({ value }: { value: unknown }) => JSON.stringify(value);

