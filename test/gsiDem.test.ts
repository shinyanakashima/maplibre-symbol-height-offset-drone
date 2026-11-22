import { describe, expect, it } from 'vitest';
import {
  DemSampler, TILE_SIZE, DEM_SOURCE_10B, DEM_SOURCE_5A, decodeGsiPixel, decodeTerrarium, encodeTerrarium, fillFromParent,
  gsiRgbaToTerrarium, lngLatToTileFloat, loadDemTile,
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

describe('5m メッシュと 10m メッシュの合成', () => {
  const N = TILE_SIZE * TILE_SIZE;
  const filled = (v: number) => new Float32Array(N).fill(v);

  it('5m の欠けた画素を 10m の親タイルで補い、元データを記録する', () => {
    const child = filled(100);
    child[0] = Number.NaN;
    const t = fillFromParent(child, filled(80), 1, 0);
    expect(t.heights[0]).toBeCloseTo(80);
    expect(t.source![0]).toBe(DEM_SOURCE_10B);
    expect(t.heights[1]).toBe(100);
    expect(t.source![1]).toBe(DEM_SOURCE_5A);
  });

  it('親タイルの該当する 1/4 を拡大して使う', () => {
    // 親タイル: x 方向に 1 画素 1m 上がる地形
    const parent = new Float32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i % TILE_SIZE;
    const right = fillFromParent(null, parent, 1, 0);
    // 子の画素 (100, 50) の中心は親の x = (256 + 100.5) / 2 - 0.5 = 177.75
    expect(right.heights[50 * TILE_SIZE + 100]).toBeCloseTo(177.75, 3);
    const left = fillFromParent(null, parent, 0, 0);
    expect(left.heights[50 * TILE_SIZE + 100]).toBeCloseTo(49.75, 3);
  });

  it('loadDemTile: auto の z15 は 5m を優先、z14 以下と dem10b は 10m', async () => {
    const calls: string[] = [];
    const fetcher = async (layer: string, z: number, x: number, y: number) => {
      calls.push(`${layer}/${z}/${x}/${y}`);
      return layer === 'dem5a_png' ? filled(5) : filled(10);
    };
    const a = await loadDemTile(fetcher, 'auto', 15, 7, 9);
    expect(a!.heights[0]).toBe(5);
    expect(calls).toEqual(['dem5a_png/15/7/9']);
    calls.length = 0;
    const b = await loadDemTile(fetcher, 'dem10b', 14, 3, 4);
    expect(b!.heights[0]).toBe(10);
    expect(calls).toEqual(['dem_png/14/3/4']);
  });

  it('loadDemTile: 5m タイルがなければ親の 10m タイルで埋める', async () => {
    const fetcher = async (layer: string) => (layer === 'dem5a_png' ? null : filled(10));
    const t = await loadDemTile(fetcher, 'auto', 15, 7, 9);
    expect(t!.heights[123]).toBeCloseTo(10);
    expect(t!.source!.every((v) => v === DEM_SOURCE_10B)).toBe(true);
    expect(await loadDemTile(async () => null, 'auto', 15, 7, 9)).toBeNull();
  });

  it('DemSampler.sourceAt で元データを返す', async () => {
    const s = new DemSampler(async () => ({ heights: filled(1), source: new Uint8Array(N).fill(DEM_SOURCE_5A) }), 15);
    await s.preload([[143.1, 42.88]]);
    expect(s.sourceAt(143.1, 42.88)).toBe('DEM5A');
  });
});
