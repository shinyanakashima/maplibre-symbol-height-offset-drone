import { describe, expect, it } from 'vitest';
import { resolveAltitude, symbolOffsets } from '../src/altitude/altitude';

const base = { groundElevation: 300, takeoff: { groundElevation: 220, assumed: false }, geoidHeight: 29.5 };

describe('resolveAltitude', () => {
  it('離陸地点相対: AGL = 離陸地点標高 + 相対高度 - 地表標高', () => {
    const r = resolveAltitude('relativeToStartPoint', 150, base);
    expect(r.status).toBe('ok');
    expect(r.absolute).toBe(370);
    expect(r.agl).toBe(70);
    expect(r.belowGround).toBe(false);
  });

  it('離陸地点相対: 尾根で地表より下になることを検出', () => {
    const r = resolveAltitude('relativeToStartPoint', 150, { ...base, groundElevation: 420 });
    expect(r.agl).toBe(-50);
    expect(r.belowGround).toBe(true);
    expect(r.notes.join()).toContain('地表より下');
  });

  it('離陸地点相対: 離陸地点を仮定した場合は参考表示', () => {
    const r = resolveAltitude('relativeToStartPoint', 60, { ...base, takeoff: { groundElevation: 300, assumed: true } });
    expect(r.status).toBe('reference');
    expect(r.agl).toBe(60);
  });

  it('離陸地点相対: 離陸地点標高が不明なら換算しない', () => {
    const r = resolveAltitude('relativeToStartPoint', 60, { ...base, takeoff: null });
    expect(r.status).toBe('reference');
    expect(r.agl).toBeNull();
  });

  it('WGS84: 標高 = 楕円体高 - ジオイド高', () => {
    const r = resolveAltitude('WGS84', 389.5, base);
    expect(r.absolute).toBeCloseTo(360);
    expect(r.agl).toBeCloseTo(60);
    expect(r.status).toBe('ok');
  });

  it('WGS84: ジオイド高が未入力なら換算せず参考表示', () => {
    const r = resolveAltitude('WGS84', 389.5, { ...base, geoidHeight: null });
    expect(r.status).toBe('reference');
    expect(r.agl).toBeNull();
    expect(r.absolute).toBeNull();
  });

  it('EGM96: 海抜高度を標高とみなす（注記付き）', () => {
    const r = resolveAltitude('EGM96', 350, base);
    expect(r.agl).toBe(50);
    expect(r.notes.join()).toContain('EGM96');
  });

  it('aboveGroundLevel: 値をそのまま AGL とする', () => {
    const r = resolveAltitude('aboveGroundLevel', 45, base);
    expect(r.agl).toBe(45);
    expect(r.absolute).toBe(345);
  });

  it('realTimeFollowSurface: 参考表示', () => {
    const r = resolveAltitude('realTimeFollowSurface', 15, base);
    expect(r.status).toBe('reference');
    expect(r.agl).toBe(15);
  });

  it('未知のモードは変換しない', () => {
    const r = resolveAltitude('somethingNew', 100, base);
    expect(r.status).toBe('unsupported');
    expect(r.agl).toBeNull();
    expect(resolveAltitude(null, 100, base).status).toBe('unsupported');
  });

  it('DEM が取れない地点は AGL を出さない', () => {
    const r = resolveAltitude('WGS84', 389.5, { ...base, groundElevation: null });
    expect(r.absolute).toBeCloseTo(360);
    expect(r.agl).toBeNull();
    expect(r.status).toBe('reference');
  });
});

describe('symbolOffsets', () => {
  it('高度が決まらない場合は地表（0m）に置く', () => {
    const r = resolveAltitude('somethingNew', 100, base);
    expect(symbolOffsets(r, 300)).toEqual({ heightAGL: 0, heightAbs: 300 });
  });
  it('ground 用と absolute 用の値を返す', () => {
    const r = resolveAltitude('relativeToStartPoint', 150, base);
    expect(symbolOffsets(r, 300)).toEqual({ heightAGL: 70, heightAbs: 370 });
  });
});
