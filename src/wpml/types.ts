/** WPML から取り出したデータの型定義。値は仕様どおりの意味で保持し、変換は altitude モジュールで行う。 */

export type ParsedSource = 'waylines.wpml' | 'template.kml';

export interface WaypointRecord {
  waylineId: number;
  /** wpml:index */
  index: number;
  lng: number;
  lat: number;
  /**
   * 高さの値。waylines.wpml では wpml:executeHeight、
   * template.kml では wpml:height（useGlobalHeight=1 のときは wpml:globalHeight）。
   */
  executeHeight: number | null;
  /** waylines.wpml の wpml:executeHeightMode、template.kml の wpml:heightMode */
  heightMode: string | null;
  /** template.kml にのみ存在する wpml:ellipsoidHeight */
  ellipsoidHeight: number | null;
  /** wpml:waypointSpeed（なければ wayline の autoFlightSpeed を補完） */
  waypointSpeed: number | null;
  speedSource: 'waypoint' | 'wayline' | 'none';
  source: ParsedSource;
}

export interface WaylineRecord {
  waylineId: number;
  templateId: number | null;
  heightMode: string | null;
  autoFlightSpeed: number | null;
  /** template.kml 由来の場合のテンプレート種別（waypoint / mapping2d など） */
  templateType: string | null;
  waypoints: WaypointRecord[];
}

export interface MissionConfig {
  flyToWaylineMode: string | null;
  finishAction: string | null;
  takeOffSecurityHeight: number | null;
  globalTransitionalSpeed: number | null;
  globalRTHHeight: number | null;
  droneEnumValue: number | null;
  droneSubEnumValue: number | null;
  payloadEnumValue: number | null;
}

/** template.kml の wpml:takeOffRefPoint（x,y,z = 緯度,経度,楕円体高） */
export interface TakeoffRef {
  lat: number;
  lng: number;
  ellipsoidHeight: number | null;
  /** wpml:takeOffRefPointAGLHeight（値の意味は仕様の記述があいまいなため変換には使わない） */
  aglHeight: number | null;
}

export interface TemplateFolderInfo {
  templateId: number | null;
  templateType: string | null;
  coordinateMode: string | null;
  heightMode: string | null;
  globalHeight: number | null;
  globalShootHeight: number | null;
  surfaceFollowModeEnable: boolean | null;
  surfaceRelativeHeight: number | null;
  autoFlightSpeed: number | null;
  /** 測量エリアなどのポリゴン（外周のみ） */
  polygons: Array<Array<[number, number]>>;
}

export interface ParsedMission {
  fileName: string;
  /** ウェイポイントを取り出したファイル */
  source: ParsedSource | null;
  /** KMZ 内のファイル一覧 */
  files: string[];
  /** wpml 名前空間 URI（バージョン確認用） */
  wpmlNamespace: string | null;
  missionConfig: MissionConfig;
  takeoffRef: TakeoffRef | null;
  waylines: WaylineRecord[];
  templateFolders: TemplateFolderInfo[];
  warnings: string[];
}
