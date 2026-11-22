/**
 * 地理院の DEM10B（z14）・DEM5A（z15）・DEM1A（z17）で、サンプルの離陸地点とウェイポイントの標高を比べる。
 *   npx tsx scripts/compare-dem.ts
 */
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { DemSampler, decodeGsiTile } from '../src/terrain/gsiDem';
import { parseKmz } from '../src/wpml/parser';
import { JSDOM } from 'jsdom';
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;
const loader = (name: string) => async (z: number, x: number, y: number) => {
  const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${name}/${z}/${x}/${y}.png`);
  if (!r.ok) return null;
  return { heights: decodeGsiTile(PNG.sync.read(Buffer.from(await r.arrayBuffer())).data) };
};
for (const f of ['hilly-relative', 'flat-relative']) {
  const m = await parseKmz(readFileSync(`public/samples/${f}.kmz`));
  const pts: [number, number][] = m.waylines[0].waypoints.map((w) => [w.lng, w.lat]);
  pts.unshift([m.takeoffRef!.lng, m.takeoffRef!.lat]);
  const s = [new DemSampler(loader('dem_png'), 14), new DemSampler(loader('dem5a_png'), 15), new DemSampler(loader('dem1a_png'), 17)];
  for (const x of s) await x.preload(pts);
  console.log(f, 'pt  10B(z14)  5A(z15)  1A(z17)');
  pts.forEach((p, i) => console.log(i === 0 ? 'TO' : 'W' + (i - 1), s.map((x) => x.elevation(...p)?.toFixed(2) ?? 'NA').join('  ')));
}
