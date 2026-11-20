import { describe, expect, it } from 'vitest';
import {
  DemSampler, TILE_SIZE, decodeGsiPixel, decodeTerrarium, encodeTerrarium, gsiRgbaToTerrarium, lngLatToTileFloat,
} from '../src/terrain/gsiDem';

describe('地理院標高タイルのデコード', () => {
  it('正の値', () => {
    // 123.45m → x = 12345 = 0x003039
    expect(decodeGsiPixel(0x00, 0x30, 0x39)).toBeCloseTo(123.45);
  });
  it('負の値（2の補数）', () => {
    // -1.00m → x = 2^24 - 100 = 0xFFFF9C
    expect(decodeGsiPixel(0xff, 0xff, 0x9c)).toBeCloseTo(-1);
  });
  it('無効値 (128,0,0) は null', () => {
    expect(decodeGsiPixel(128, 0, 0)).toBeNull();
  });
});

describe('Terrarium 変換', () => {
  it('往復で 1/256m 以内', () => {
    for (const h of [0, 12.34, 1234.5, -5.6, 3776.24]) {
      const [r, g, b] = encodeTerrarium(h);
      expect(Math.abs(decodeTerrarium(r, g, b) - h)).toBeLessThan(1 / 256 + 1e-9);
    }
  });
  it('RGBA 配列を書き換える（NA は 0m）', () => {
    const a = new Uint8ClampedArray([0x00, 0x30, 0x39, 255, 128, 0, 0, 255]);
    gsiRgbaToTerrarium(a);
    expect(decodeTerrarium(a[0], a[1], a[2])).toBeCloseTo(123.45, 1);
    expect(decodeTerrarium(a[4], a[5], a[6])).toBeCloseTo(0);
  });
});

describe('DemSampler', () => {
  it('タイル座標の計算', () => {
    const { x, y } = lngLatToTileFloat(0, 0, 1);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(1);
  });

  it('ピクセル中心の間を双線形補間する', async () => {
    // 東に向かって 1 ピクセルごとに 1m 上がる地形
    const loader = async () => {
      const h = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < h.length; i++) h[i] = i % TILE_SIZE;
      return { heights: h };
    };
    const s = new DemSampler(loader, 14);
    const lng = 143.1, lat = 42.88;
    await s.preload([[lng, lat]]);
    const { x } = lngLatToTileFloat(lng, lat, 14);
    const px = x * TILE_SIZE;
    const expected = (px - Math.floor(px / TILE_SIZE) * TILE_SIZE) - 0.5;
    expect(s.elevation(lng, lat)).toBeCloseTo(expected, 3);
  });

  it('タイルが読めない場合は null', async () => {
    const s = new DemSampler(async () => null, 14);
    await s.preload([[143.1, 42.88]]);
    expect(s.elevation(143.1, 42.88)).toBeNull();
  });
});
