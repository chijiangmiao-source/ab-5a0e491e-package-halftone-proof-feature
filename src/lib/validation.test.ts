import { describe, expect, it } from 'vitest';
import { parseHexColor, parsePaletteEntries, parseThreshold } from './validation';

describe('parseHexColor', () => {
  it('接受六位十六进制并按 RGB 解析', () => {
    expect(parseHexColor('1a2B3C')).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
    expect(parseHexColor('  FFFFFF ')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('拒绝短色、长色、非十六进制字符与空串', () => {
    expect(parseHexColor('FFF')).toBeNull();
    expect(parseHexColor('#FFFFFF')).toBeNull();
    expect(parseHexColor('GGGGGG')).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });
});

describe('parsePaletteEntries', () => {
  it('通过 2~8 个合法不重复色值', () => {
    const r = parsePaletteEntries(['000000', 'ffffff']);
    expect(r.error).toBeNull();
    expect(r.colors).toHaveLength(2);
  });

  it('数量不足或超出都报错', () => {
    expect(parsePaletteEntries(['000000']).error).toMatch(/2~8/);
    const eight = Array.from({ length: 8 }, (_, i) => i.toString(16).padStart(2, '0').repeat(3));
    expect(parsePaletteEntries(eight).error).toBeNull();
    const nine = [...eight, 'abcdef'];
    expect(parsePaletteEntries(nine).error).toMatch(/2~8/);
  });

  it('非法条目录入字段错误并给出整体错误', () => {
    const r = parsePaletteEntries(['000000', 'xyz', 'ffffff']);
    expect(r.fieldErrors[1]).not.toBe('');
    expect(r.error).toMatch(/第 2 个/);
    expect(r.colors).toEqual([]);
  });

  it('重复色值（忽略大小写与空白）报错并标出后者', () => {
    const r = parsePaletteEntries(['000000', 'ff0000', ' FF0000']);
    expect(r.error).toMatch(/重复/);
    expect(r.fieldErrors[2]).toMatch(/与第 2 个/);
  });
});

describe('parseThreshold', () => {
  it('接受 0~255 整数', () => {
    expect(parseThreshold('0')).toEqual({ value: 0, error: null });
    expect(parseThreshold('255')).toEqual({ value: 255, error: null });
    expect(parseThreshold(' 128 ')).toEqual({ value: 128, error: null });
  });

  it('拒绝越界、小数与非数字', () => {
    expect(parseThreshold('-1').error).toMatch(/0~255/);
    expect(parseThreshold('256').error).toMatch(/0~255/);
    expect(parseThreshold('12.5').error).toMatch(/整数/);
    expect(parseThreshold('abc').error).toMatch(/整数/);
  });
});
