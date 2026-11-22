/**
 * 国土地理院 標高タイル（PNG形式）のデコードとサンプリング。
 *
 * 標高タイル（dem_png）の仕様:
 *   x = 2^16 R + 2^8 G + B
 *   x <  2^23 のとき h = x * u
 *   x =  2^23 のとき h = NA（無効値）
 *   x >  2^23 のとき h = (x - 2^24) * u
 *   u = 0.01 m
 * 標高の基準は東京湾平均海面（ジオイド面）。楕円体高ではない。
 *
 * MapLibre の raster-dem は terrarium / mapbox / custom(線形) しか解釈できず、
 * 地理院の2の補数表現と NA を扱えないため、addProtocol で Terrarium 形式に変換して渡す。
 */

export const GSI_DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const GSI_DEM_MAX_ZOOM = 14;
export const TILE_SIZE = 256;

/**
 * 標高タイルの種類
 *   dem_png   : 基盤地図情報 10m メッシュ（DEM10B、地形図の等高線から作成、標準偏差 5m 以内）。z0–14、全国
 *   dem5a_png : 基盤地図情報 5m メッシュ（DEM5A、航空レーザ測量、標準偏差 0.3m 以内）。z15、整備済み地域のみ
 */
export type GsiDemLayer = 'dem_png' | 'dem5a_png';
export const GSI_DEM5A_ZOOM = 15;
export const gsiDemUrl = (layer: GsiDemLayer, z: number, x: number, y: number) =>
  `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.png`;

/**
 * DEM の使い方
 *   auto   : 5m メッシュ（DEM5A）を優先し、データのない画素は 10m メッシュで補う（z15）
 *   dem10b : 10m メッシュのみ（z14）
 */
export type DemMode = 'auto' | 'dem10b';

/** 画素ごとの元データ */
export const DEM_SOURCE_10B = 0;
export const DEM_SOURCE_5A = 1;

/** 地理院標高タイルの1ピクセルを標高(m)に変換。NA のときは null。 */
export function decodeGsiPixel(r: number, g: number, b: number): number | null {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  if (x < 8388608) return x * 0.01;
  return (x - 16777216) * 0.01;
}

/** 標高(m)を Terrarium 形式の RGB にエンコード。 */
export function encodeTerrarium(h: number): [number, number, number] {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v) % 256;
  const b = Math.floor((v - Math.floor(v)) * 256);
  return [r, g, b];
}

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** RGBA 配列（地理院形式）を標高配列に変換。NA は NaN。 */
export function decodeGsiTile(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = decodeGsiPixel(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    out[i] = h === null ? Number.NaN : h;
  }
  return out;
}

/** 地理院形式の RGBA を Terrarium 形式の RGBA に書き換える（NA は 0m とする）。 */
export function gsiRgbaToTerrarium(rgba: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const h = decodeGsiPixel(rgba[i], rgba[i + 1], rgba[i + 2]) ?? 0;
    const [r, g, b] = encodeTerrarium(h);
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
}

/** 経緯度 → タイル座標（小数）。Web メルカトル。 */
export function lngLatToTileFloat(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export type TileKey = `${number}/${number}/${number}`;

export interface DemTile {
  /** TILE_SIZE*TILE_SIZE の標高配列（m）。NA は NaN */
  heights: Float32Array;
  /** 画素ごとの元データ（DEM_SOURCE_5A / DEM_SOURCE_10B）。省略時はすべて 10B */
  source?: Uint8Array;
}

/** タイル 1 枚の標高配列を取得する関数（ない場合は null） */
export type HeightsFetcher = (layer: GsiDemLayer, z: number, x: number, y: number) => Promise<Float32Array | null>;

/** 親タイル（1 つ上のズーム）の標高を、子タイルの画素中心で双線形補間する */
function sampleParent(parent: Float32Array, qx: number, qy: number, cx: number, cy: number): number {
  const px = (qx * TILE_SIZE + cx + 0.5) / 2 - 0.5;
  const py = (qy * TILE_SIZE + cy + 0.5) / 2 - 0.5;
  const clamp = (v: number) => Math.min(TILE_SIZE - 1, Math.max(0, v));
  const x0 = clamp(Math.floor(px));
  const y0 = clamp(Math.floor(py));
  const x1 = clamp(x0 + 1);
  const y1 = clamp(y0 + 1);
  const fx = Math.min(1, Math.max(0, px - x0));
  const fy = Math.min(1, Math.max(0, py - y0));
  const h = (x: number, y: number) => parent[y * TILE_SIZE + x];
  return h(x0, y0) * (1 - fx) * (1 - fy) + h(x1, y0) * fx * (1 - fy) + h(x0, y1) * (1 - fx) * fy + h(x1, y1) * fx * fy;
}

/**
 * 5m メッシュのタイルの NA 画素を、10m メッシュの親タイルで埋める。
 * @param child  DEM5A の標高配列（タイル自体がない場合は null）
 * @param parent DEM10B の 1 つ上のズームのタイル（ない場合は null）
 * @param qx, qy 子タイルが親タイルの左右・上下どちらの 1/4 か（0 または 1）
 */
export function fillFromParent(child: Float32Array | null, parent: Float32Array | null, qx: number, qy: number): DemTile {
  const n = TILE_SIZE * TILE_SIZE;
  const heights = new Float32Array(n);
  const source = new Uint8Array(n);
  for (let cy = 0; cy < TILE_SIZE; cy++) {
    for (let cx = 0; cx < TILE_SIZE; cx++) {
      const i = cy * TILE_SIZE + cx;
      const v = child ? child[i] : Number.NaN;
      if (Number.isFinite(v)) {
        heights[i] = v;
        source[i] = DEM_SOURCE_5A;
      } else {
        heights[i] = parent ? sampleParent(parent, qx, qy, cx, cy) : Number.NaN;
        source[i] = DEM_SOURCE_10B;
      }
    }
  }
  return { heights, source };
}

/**
 * DEM のモードに応じてタイルを読み込む。auto の z15 では 5m メッシュを優先し、欠けた画素を 10m メッシュで補う。
 * MapLibre の Terrain と高度換算用サンプラーの両方がこの関数を使うので、両者の地表は同じになる。
 */
export async function loadDemTile(fetchHeights: HeightsFetcher, mode: DemMode, z: number, x: number, y: number): Promise<DemTile | null> {
  if (mode === 'dem10b' || z < GSI_DEM5A_ZOOM) {
    const h = await fetchHeights('dem_png', Math.min(z, GSI_DEM_MAX_ZOOM), x, y);
    return h ? { heights: h } : null;
  }
  const child = await fetchHeights('dem5a_png', z, x, y);
  const complete = child !== null && child.every((v) => Number.isFinite(v));
  if (complete) return { heights: child, source: new Uint8Array(child.length).fill(DEM_SOURCE_5A) };
  const parent = await fetchHeights('dem_png', z - 1, x >> 1, y >> 1);
  if (!child && !parent) return null;
  return fillFromParent(child, parent, x & 1, y & 1);
}

export function demModeZoom(mode: DemMode): number {
  return mode === 'auto' ? GSI_DEM5A_ZOOM : GSI_DEM_MAX_ZOOM;
}

/** タイルを取得する関数。ブラウザでは fetch + canvas、テストではモックを注入する。 */
export type DemTileLoader = (z: number, x: number, y: number) => Promise<DemTile | null>;

/**
 * DEM サンプラー。指定ズームのタイルを事前読み込みし、同期的に双線形補間で標高を返す。
 * MapLibre の queryTerrainElevation() は描画中のタイルズームに依存して値が変わり、
 * Terrain 無効時は null を返すため、高度変換には独立したサンプラーを使う。
 */
export class DemSampler {
  private tiles = new Map<TileKey, DemTile | null>();
  private pending = new Map<TileKey, Promise<DemTile | null>>();

  constructor(
    private loader: DemTileLoader,
    public readonly zoom: number = GSI_DEM_MAX_ZOOM,
  ) {}

  private key(x: number, y: number): TileKey {
    return `${this.zoom}/${x}/${y}`;
  }

  /** 経緯度の集合を囲むタイルを読み込む。 */
  async preload(points: Array<[number, number]>): Promise<void> {
    const needed = new Set<string>();
    for (const [lng, lat] of points) {
      const { x, y } = lngLatToTileFloat(lng, lat, this.zoom);
      // 双線形補間でタイル境界をまたぐため、近傍タイルも読み込む
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;
      for (const dx of [-1, 1]) {
        for (const dy of [-1, 1]) {
          needed.add(`${Math.floor((px + dx) / TILE_SIZE)}/${Math.floor((py + dy) / TILE_SIZE)}`);
        }
      }
    }
    await Promise.all(
      [...needed].map((s) => {
        const [x, y] = s.split('/').map(Number);
        return this.loadTile(x, y);
      }),
    );
  }

  private loadTile(x: number, y: number): Promise<DemTile | null> {
    const k = this.key(x, y);
    if (this.tiles.has(k)) return Promise.resolve(this.tiles.get(k) ?? null);
    const p = this.pending.get(k);
    if (p) return p;
    const promise = this.loader(this.zoom, x, y)
      .catch(() => null)
      .then((t) => {
        this.tiles.set(k, t);
        this.pending.delete(k);
        return t;
      });
    this.pending.set(k, promise);
    return promise;
  }

  private pixel(gx: number, gy: number): number {
    const tx = Math.floor(gx / TILE_SIZE);
    const ty = Math.floor(gy / TILE_SIZE);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return Number.NaN;
    const ix = gx - tx * TILE_SIZE;
    const iy = gy - ty * TILE_SIZE;
    return t.heights[iy * TILE_SIZE + ix];
  }

  /** 経緯度に最も近い画素の元データ（'DEM5A' / 'DEM10B'）。タイル未読込なら null */
  sourceAt(lng: number, lat: number): 'DEM5A' | 'DEM10B' | null {
    const { x, y } = lngLatToTileFloat(lng, lat, this.zoom);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return null;
    if (!t.source) return 'DEM10B';
    const ix = Math.min(TILE_SIZE - 1, Math.floor((x - tx) * TILE_SIZE));
    const iy = Math.min(TILE_SIZE - 1, Math.floor((y - ty) * TILE_SIZE));
    return t.source[iy * TILE_SIZE + ix] === DEM_SOURCE_5A ? 'DEM5A' : 'DEM10B';
  }

  /**
   * 標高(m, ジオイド基準)を返す。タイル未読込・NA のときは null。
   * ピクセル中心を格子点として双線形補間する。
   */
  elevation(lng: number, lat: number): number | null {
    const { x, y } = lngLatToTileFloat(lng, lat, this.zoom);
    const gx = x * TILE_SIZE - 0.5;
    const gy = y * TILE_SIZE - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const h00 = this.pixel(x0, y0);
    const h10 = this.pixel(x0 + 1, y0);
    const h01 = this.pixel(x0, y0 + 1);
    const h11 = this.pixel(x0 + 1, y0 + 1);
    const v = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
    return Number.isFinite(v) ? v : null;
  }
}
