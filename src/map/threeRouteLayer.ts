import * as maplibregl from 'maplibre-gl';
import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

export interface Route3DPoint {
  lng: number;
  lat: number;
  /** 描画上の高さ（m）: 線の頂点 */
  top: number;
  /** 描画上の地表の高さ（m）: 垂直線の下端 */
  bottom: number;
}

export interface Route3D {
  color: string;
  points: Route3DPoint[];
}

/**
 * ウェイポイントを高さ付きで結ぶ 3D ラインと、地表からの垂直線を描く Custom Layer。
 * MapLibre の line レイヤーは頂点ごとの高さを持てないため、ここだけ Three.js を使う。
 * renderingMode: '3d' で MapLibre の深度バッファを共有するので、地形の陰に入った線は隠れる。
 */
export class ThreeRouteLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private group = new THREE.Group();
  private materials: LineMaterial[] = [];
  private origin = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  private scale = 1;
  private routes: Route3D[] = [];
  showRoute = true;
  showDropLines = true;

  constructor(id = 'route-3d') {
    this.id = id;
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.scene.add(this.group);
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.rebuild();
  }

  onRemove(): void {
    this.clear();
    this.renderer?.dispose();
  }

  setRoutes(routes: Route3D[]): void {
    this.routes = routes;
    if (this.map) this.rebuild();
  }

  setVisibility(route: boolean, drop: boolean): void {
    this.showRoute = route;
    this.showDropLines = drop;
    if (this.map) this.rebuild();
  }

  private clear(): void {
    for (const obj of [...this.group.children]) {
      this.group.remove(obj);
      (obj as THREE.Mesh).geometry?.dispose();
    }
    this.materials.forEach((m) => m.dispose());
    this.materials = [];
  }

  private local(p: { lng: number; lat: number }, z: number): [number, number, number] {
    const mc = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], 0);
    return [(mc.x - this.origin.x) / this.scale, -(mc.y - this.origin.y) / this.scale, z];
  }

  private material(color: string, width: number, dashed: boolean, opacity = 1): LineMaterial {
    const m = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      dashed,
      dashSize: 6,
      gapSize: 4,
      transparent: opacity < 1,
      opacity,
      worldUnits: false,
    });
    const c = this.map.getCanvas();
    m.resolution.set(c.clientWidth, c.clientHeight);
    this.materials.push(m);
    return m;
  }

  private rebuild(): void {
    this.clear();
    const all = this.routes.flatMap((r) => r.points);
    if (all.length === 0) {
      this.map.triggerRepaint();
      return;
    }
    // 原点をミッション付近に置き、ローカル座標（m）で頂点を持つ（float32 の精度対策）
    const c = all.reduce((a, p) => ({ lng: a.lng + p.lng / all.length, lat: a.lat + p.lat / all.length }), { lng: 0, lat: 0 });
    this.origin = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();

    for (const r of this.routes) {
      if (this.showRoute && r.points.length >= 2) {
        const g = new LineGeometry();
        g.setPositions(r.points.flatMap((p) => this.local(p, p.top)));
        const line = new Line2(g, this.material(r.color, 4, false));
        line.computeLineDistances();
        line.frustumCulled = false;
        this.group.add(line);
      }
      if (this.showDropLines) {
        const g = new LineSegmentsGeometry();
        g.setPositions(r.points.flatMap((p) => [...this.local(p, p.bottom), ...this.local(p, p.top)]));
        const seg = new LineSegments2(g, this.material(r.color, 1.5, true, 0.9));
        seg.computeLineDistances();
        seg.frustumCulled = false;
        this.group.add(seg);
      }
    }
    this.map.triggerRepaint();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const s = this.scale;
    // v6 の modelViewProjectionMatrix はワールドピクセル座標用。MercatorCoordinate（0〜1）用の行列は
    // defaultProjectionData.mainMatrix にある。
    const mvp = new THREE.Matrix4().fromArray(Array.from(options.defaultProjectionData.mainMatrix as ArrayLike<number>));
    const model = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(s, -s, s));
    // LineMaterial は投影行列の [2][3] が -1 のときだけ透視投影としてビュー空間で線分を切り詰める。
    // ここでは MVP×モデル行列をまとめて渡すので、その処理は行われず、クリップ空間で太さが付けられる。
    this.camera.projectionMatrix.copy(mvp.multiply(model));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const canvas = this.map.getCanvas();
    for (const mat of this.materials) mat.resolution.set(canvas.clientWidth, canvas.clientHeight);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}
