import * as maplibregl from 'maplibre-gl';
import { GSI_DEM_URL, TILE_SIZE, decodeGsiTile, encodeTerrarium, gsiRgbaToTerrarium, type DemTile } from './gsiDem';

const tileUrl = (z: number, x: number, y: number) =>
  GSI_DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** PNG を RGBA に展開する。色空間変換・乗算済みアルファを無効にしないと標高値が壊れる。 */
async function pngToRgba(blob: Blob): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** DemSampler 用ローダー（ブラウザ） */
export async function browserGsiLoader(z: number, x: number, y: number): Promise<DemTile | null> {
  const res = await fetch(tileUrl(z, x, y));
  if (!res.ok) return null;
  return { heights: decodeGsiTile(await pngToRgba(await res.blob())) };
}

let flatTile: ArrayBuffer | null = null;
async function flatTerrariumTile(): Promise<ArrayBuffer> {
  if (flatTile) return flatTile;
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d')!;
  const [r, g, b] = encodeTerrarium(0);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  flatTile = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  return flatTile;
}

let registered = false;

/**
 * gsidem://{z}/{x}/{y} で地理院標高タイルを Terrarium 形式に変換して返すプロトコルを登録する。
 * 日本国外などタイルがない場所は 0m の平坦タイルを返す。
 */
export function registerGsiDemProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('gsidem', async (params, abortController) => {
    const m = params.url.match(/gsidem:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`invalid url ${params.url}`);
    const res = await fetch(tileUrl(+m[1], +m[2], +m[3]), { signal: abortController.signal });
    if (!res.ok) return { data: await flatTerrariumTile() };
    const rgba = await pngToRgba(await res.blob());
    gsiRgbaToTerrarium(rgba);
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, TILE_SIZE, TILE_SIZE), 0, 0);
    return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() };
  });
}
