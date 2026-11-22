import { describe, expect, it } from 'vitest';
import { buildTimeline, horizontalDistance, stateAt, type TimelinePoint } from '../src/animation/timeline';

const p = (lng: number, lat: number, absolute: number | null, speed: number | null, label: string): TimelinePoint => ({
  lng, lat, absolute, agl: absolute ?? 0, speed, label,
});

describe('timeline', () => {
  it('水平距離（緯度 1/1000 度 ≒ 111m）', () => {
    expect(horizontalDistance({ lng: 143, lat: 42.88 }, { lng: 143, lat: 42.881 })).toBeCloseTo(111.3, 0);
  });

  it('速度から所要時間を推定し、高さの差も距離に含める', () => {
    const tl = buildTimeline([p(143, 42.88, 100, 10, '0'), p(143, 42.88, 130, 10, '1'), p(143, 42.881, 130, null, '2')]);
    expect(tl.segments[0].duration).toBeCloseTo(3);
    expect(tl.segments[1].speedAssumed).toBe(false);
    expect(tl.totalTime).toBeCloseTo(3 + 111.3 / 10, 0);
    expect(tl.usesAssumedSpeed).toBe(false);
  });

  it('速度がない区間は仮の速度を使いフラグを立てる', () => {
    const tl = buildTimeline([p(143, 42.88, 100, null, '0'), p(143, 42.881, 100, null, '1')], 5);
    expect(tl.usesAssumedSpeed).toBe(true);
    expect(tl.segments[0].speed).toBe(5);
  });

  it('途中の状態を補間する', () => {
    const tl = buildTimeline([p(143, 42.88, 100, 10, '0'), p(143, 42.88, 140, 10, '1')]);
    const s = stateAt(tl, 2)!;
    expect(s.absolute).toBeCloseTo(120);
    expect(s.fromLabel).toBe('0');
    expect(stateAt(tl, 999)!.absolute).toBeCloseTo(140);
  });
});
