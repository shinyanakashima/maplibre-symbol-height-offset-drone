import type { Map as MlMap } from 'maplibre-gl';
import { WAYLINE_COLORS } from '../wpml/geojson';

const PR = 2;

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size * PR;
  const ctx = c.getContext('2d')!;
  ctx.scale(PR, PR);
  return [c, ctx];
}

function add(map: MlMap, id: string, size: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const [c, ctx] = makeCanvas(size);
  draw(ctx);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, data, { pixelRatio: PR });
}

/**
 * ウェイポイント用アイコン。状態ごとに形を変える。
 *   ok          : 塗りつぶしの円（高さが確定）
 *   reference   : 白抜きの円（参考表示）
 *   unsupported : 灰色の菱形（変換しない・地表に配置）
 */
export function addIcons(map: MlMap): void {
  WAYLINE_COLORS.forEach((color, i) => {
    add(map, `wp-${i}-ok`, 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(13, 13, 10.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    });
    add(map, `wp-${i}-reference`, 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(13, 13, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.setLineDash([4, 2.5]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
  });
  add(map, 'wp-unsupported', 26, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(13, 2);
    ctx.lineTo(24, 13);
    ctx.lineTo(13, 24);
    ctx.lineTo(2, 13);
    ctx.closePath();
    ctx.fillStyle = '#868e96';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });
  add(map, 'wp-selected', 38, (ctx) => {
    ctx.beginPath();
    ctx.arc(19, 19, 16, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffd43b';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(19, 19, 18, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#212529';
    ctx.stroke();
  });
  add(map, 'takeoff', 30, (ctx) => {
    ctx.beginPath();
    ctx.arc(15, 15, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#212529';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd43b';
    ctx.stroke();
    ctx.fillStyle = '#ffd43b';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', 15, 16);
  });
  // 上から見たクアッドコプター
  add(map, 'drone', 40, (ctx) => {
    ctx.translate(20, 20);
    ctx.strokeStyle = '#212529';
    ctx.lineWidth = 3;
    for (const a of [45, 135, 225, 315]) {
      const r = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(r) * 12, Math.sin(r) * 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(r) * 12, Math.sin(r) * 12, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 3;
    }
    ctx.beginPath();
    ctx.roundRect(-5, -6, 10, 12, 3);
    ctx.fillStyle = '#e03131';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });
}
