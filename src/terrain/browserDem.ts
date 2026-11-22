import * as maplibregl from 'maplibre-gl';
import {
  TILE_SIZE,
  decodeGsiTile,
  encodeTerrarium,
  gsiDemUrl,
  loadDemTile,
  type DemMode,
  type DemTile,
  type GsiDemLayer,
} from './gsiDem';

/** PNG を RGBA に展開する。色空間変換・乗算済みアルファを無効にしないと標高値が壊れる。 */
async function pngToRgba(blob: Blob): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * 地理院標高タイルを取得して標高配列にする。Terrain と高度換算用サンプラーで同じタイルを
 * 二重に取得しないよう、直近のタイルをメモリに保持する。
 */
const cache = new Map<string, Promise<Float32Array | null>>();
const CACHE_MAX = 600;

function fetchHeights(layer: GsiDemLayer, z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${layer}/${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetch(gsiDemUrl(layer, z, x, y))
    .then(async (res) => (res.ok ? decodeGsiTile(await pngToRgba(await res.blob())) : null))
    .catch(() => {
      cache.delete(key);
      return null;
    });
  cache.set(key, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** DemSampler 用ローダー（ブラウザ） */
export function browserDemLoader(mode: DemMode) {
  return (z: number, x: number, y: number): Promise<DemTile | null> => loadDemTile(fetchHeights, mode, z, x, y);
}

async function heightsToTerrariumPng(heights: Float32Array): Promise<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    const [r, g, b] = encodeTerrarium(Number.isFinite(h) ? h : 0);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, TILE_SIZE, TILE_SIZE), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

let registered = false;

/**
 * gsidem://{mode}/{z}/{x}/{y} で地理院標高タイルを Terrarium 形式に変換して返すプロトコルを登録する。
 * mode = auto は 5m メッシュ優先（z15）、dem10b は 10m メッシュのみ（z14）。
 * 日本国外などタイルがない場所は 0m の平坦タイルを返す。
 */
export function registerGsiDemProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('gsidem', async (params) => {
    const m = params.url.match(/gsidem:\/\/(auto|dem10b)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`invalid url ${params.url}`);
    const tile = await loadDemTile(fetchHeights, m[1] as DemMode, +m[2], +m[3], +m[4]);
    return { data: await heightsToTerrariumPng(tile?.heights ?? new Float32Array(TILE_SIZE * TILE_SIZE)) };
  });
}
