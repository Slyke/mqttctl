export type InterpolateFallback = string | boolean;
export type InterpolateValues = Record<string, unknown> | unknown[] | null | undefined;

export const interpolate = (
  template: string,
  values: InterpolateValues,
  fallback: InterpolateFallback = ''
) => {
  const source = values ?? {};
  const isArr = Array.isArray(source);
  const pattern = isArr ? /{#([1-9][0-9]*|n)}/g : /{\$([a-zA-Z_][a-zA-Z0-9_]*)}/g;

  let idx = 0;

  return template.replace(pattern, (match, key) => {
    let val: unknown;

    if (isArr) {
      const arrayValues = source as unknown[];

      if (key === 'n') {
        val = arrayValues[idx];
        idx += 1;
      } else {
        val = arrayValues[Number.parseInt(key, 10) - 1];
      }
    } else {
      val = (source as Record<string, unknown>)[key];
    }

    if (val !== undefined) {
      return String(val);
    }

    return fallback === true ? match : String(fallback);
  });
};
