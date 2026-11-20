import { PNG } from 'pngjs';
import { decodeGsiTile, GSI_DEM_URL, type DemTile } from '../src/terrain/gsiDem';

/** Node 用の地理院標高タイルローダー（サンプル生成・検証スクリプト用） */
export async function nodeGsiLoader(z: number, x: number, y: number): Promise<DemTile | null> {
  const url = GSI_DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const res = await fetch(url);
  if (!res.ok) return null;
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  return { heights: decodeGsiTile(png.data) };
}
