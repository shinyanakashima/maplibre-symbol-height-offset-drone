import { PNG } from 'pngjs';
import { decodeGsiTile, gsiDemUrl, loadDemTile, type DemMode, type DemTile, type GsiDemLayer } from '../src/terrain/gsiDem';

/** Node 用の地理院標高タイル取得（サンプル生成・検証スクリプト用） */
export async function nodeFetchHeights(layer: GsiDemLayer, z: number, x: number, y: number): Promise<Float32Array | null> {
  const res = await fetch(gsiDemUrl(layer, z, x, y));
  if (!res.ok) return null;
  return decodeGsiTile(PNG.sync.read(Buffer.from(await res.arrayBuffer())).data);
}

/** アプリと同じ規則（5m メッシュ優先・10m で補完）で読むローダー */
export function nodeDemLoader(mode: DemMode) {
  return (z: number, x: number, y: number): Promise<DemTile | null> => loadDemTile(nodeFetchHeights, mode, z, x, y);
}

/** 10m メッシュ（dem_png）のみ */
export const nodeGsiLoader = nodeDemLoader('dem10b');
