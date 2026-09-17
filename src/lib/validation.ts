/** 参数校验：专色色板与透明阈值。所有规则就地给出可展示的中文错误。 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ParsedPalette {
  colors: RGB[];
  /** 每个输入条目的错误信息（无错误为空串），用于就地报错 */
  fieldErrors: string[];
  error: string | null;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

export function parseHexColor(input: string): RGB | null {
  if (!HEX6.test(input.trim())) return null;
  const h = input.trim();
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * 解析 2~8 个不重复六位 RGB 色值。
 * 非法、数量不符、重复都会在 fieldErrors / error 中标注。
 */
export function parsePaletteEntries(entries: string[]): ParsedPalette {
  const fieldErrors: string[] = new Array(entries.length).fill('');
  const colors: RGB[] = [];
  let firstFormatError = -1;

  for (let i = 0; i < entries.length; i++) {
    const c = parseHexColor(entries[i]);
    if (!c) {
      fieldErrors[i] = '需要 6 位十六进制 RGB，例如 1A2B3C';
      firstFormatError = firstFormatError === -1 ? i : firstFormatError;
      continue;
    }
    colors.push(c);
  }

  let error: string | null = null;
  if (entries.length < 2 || entries.length > 8) {
    error = `专色数量必须为 2~8 个，当前 ${entries.length} 个`;
  } else if (firstFormatError !== -1) {
    error = `第 ${firstFormatError + 1} 个色值格式非法`;
  } else {
    const seen = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i].trim().toUpperCase();
      const prev = seen.get(key);
      if (prev !== undefined) {
        fieldErrors[i] = `与第 ${prev + 1} 个色值重复`;
        error = error ?? `色值 ${key} 重复（第 ${prev + 1}、${i + 1} 个）`;
      } else {
        seen.set(key, i);
      }
    }
  }

  return { colors: error ? [] : colors, fieldErrors, error };
}

export interface ThresholdResult {
  value: number;
  error: string | null;
}

/** 透明阈值必须是 0~255 的整数（alpha 严格小于阈值才透明）。 */
export function parseThreshold(raw: string): ThresholdResult {
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) {
    return { value: 0, error: '透明阈值必须是 0~255 的整数' };
  }
  const v = Number(t);
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    return { value: 0, error: '透明阈值必须落在 0~255' };
  }
  return { value: v, error: null };
}
