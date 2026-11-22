/**
 * DJI WPML の高度を MapLibre の高さ表現に変換する。
 *
 * 用語（このモジュール内での定義）
 *   AGL       : その地点の地表面からの高さ（MapLibre の symbol-height-anchor: "ground" の symbol-height-offset に相当）
 *   標高      : ジオイド（平均海面）からの高さ。地理院 DEM の値と同じ基準（symbol-height-anchor: "absolute" に相当）
 *   楕円体高  : WGS84 楕円体からの高さ。標高 = 楕円体高 - ジオイド高
 *   離陸地点相対高度 : 離陸地点からの高さ
 *
 * 方針: 変換に必要な情報（離陸地点、ジオイド高、DEM）がそろわない場合は値を作らず、
 *       status を 'reference'（参考表示）や 'unsupported'（未対応）にして理由を notes に残す。
 */

export type AltitudeStatus = 'ok' | 'reference' | 'unsupported';

export interface TakeoffContext {
  /** 離陸地点の地表標高（DEM, m）。取得できなければ null */
  groundElevation: number | null;
  /** 離陸地点がファイルに記録されておらず、仮定した位置である */
  assumed: boolean;
}

export interface AltitudeInputs {
  /** ウェイポイント直下の地表標高（DEM, m） */
  groundElevation: number | null;
  /** 離陸地点 */
  takeoff: TakeoffContext | null;
  /** ジオイド高 N（m）。楕円体高 = 標高 + N。不明なら null */
  geoidHeight: number | null;
}

export interface AltitudeResult {
  status: AltitudeStatus;
  /** 地表面からの高さ（m）。決まらない場合は null */
  agl: number | null;
  /** 標高（ジオイド基準, m）。決まらない場合は null */
  absolute: number | null;
  /** 地表より下になる */
  belowGround: boolean;
  notes: string[];
}

export const HEIGHT_MODE_LABELS: Record<string, string> = {
  WGS84: '楕円体高（WGS84）',
  EGM96: '海抜高度（EGM96）',
  relativeToStartPoint: '離陸地点相対高度',
  aboveGroundLevel: '対地高度（AGL）',
  realTimeFollowSurface: 'リアルタイム地表追従',
};

export function heightModeLabel(mode: string | null): string {
  if (!mode) return '不明（未指定）';
  return HEIGHT_MODE_LABELS[mode] ?? `未対応のモード（${mode}）`;
}

function fromAbsolute(absolute: number, ground: number | null): Pick<AltitudeResult, 'agl' | 'absolute' | 'belowGround'> {
  if (ground === null) return { agl: null, absolute, belowGround: false };
  const agl = absolute - ground;
  return { agl, absolute, belowGround: agl < 0 };
}

/**
 * 1 つのウェイポイントの高さを変換する。
 * @param heightMode wpml:executeHeightMode（waylines.wpml）または wpml:heightMode（template.kml）
 * @param value      wpml:executeHeight または wpml:height
 */
export function resolveAltitude(heightMode: string | null, value: number | null, inputs: AltitudeInputs): AltitudeResult {
  const ground = inputs.groundElevation;
  const notes: string[] = [];

  if (value === null) {
    return { status: 'unsupported', agl: null, absolute: null, belowGround: false, notes: ['高さの値がありません'] };
  }

  switch (heightMode) {
    case 'relativeToStartPoint': {
      // AGL = 離陸地点標高 + 離陸地点相対高度 - ウェイポイント地点の地表標高
      // 離陸地点とウェイポイントの標高を同じ DEM から取るため、DEM の鉛直基準は相殺される。
      const tk = inputs.takeoff;
      if (!tk || tk.groundElevation === null) {
        notes.push('離陸地点の標高が取得できないため、地表からの高さに換算できません');
        return { status: 'reference', agl: null, absolute: null, belowGround: false, notes };
      }
      const absolute = tk.groundElevation + value;
      const r = fromAbsolute(absolute, ground);
      if (ground === null) notes.push('ウェイポイント地点の DEM 標高が取得できません');
      let status: AltitudeStatus = ground === null ? 'reference' : 'ok';
      if (tk.assumed) {
        status = 'reference';
        notes.push('離陸地点がファイルにないため、仮定した離陸地点で換算しています');
      }
      if (r.belowGround) notes.push('換算後の高さが地表より下になります');
      return { status, ...r, notes };
    }

    case 'WGS84': {
      // 楕円体高 → 標高 には ジオイド高 が必要。ジオイド高が不明なら換算しない。
      if (inputs.geoidHeight === null) {
        notes.push('楕円体高です。ジオイド高が未入力のため標高・地表からの高さに換算していません');
        return { status: 'reference', agl: null, absolute: null, belowGround: false, notes };
      }
      const absolute = value - inputs.geoidHeight;
      const r = fromAbsolute(absolute, ground);
      if (ground === null) notes.push('ウェイポイント地点の DEM 標高が取得できません');
      notes.push('入力したジオイド高で楕円体高を標高に換算しています');
      if (r.belowGround) notes.push('換算後の高さが地表より下になります');
      return { status: ground === null ? 'reference' : 'ok', ...r, notes };
    }

    case 'EGM96': {
      // template.kml のみ。EGM96 ジオイドと地理院 DEM の基準（日本のジオイド）は一致しないが差は小さい（概ね 1m 程度以内）
      const r = fromAbsolute(value, ground);
      notes.push('EGM96 の海抜高度を DEM の標高とみなしています（ジオイドモデルの差は補正していません）');
      if (r.belowGround) notes.push('換算後の高さが地表より下になります');
      return { status: ground === null ? 'reference' : 'ok', ...r, notes };
    }

    case 'aboveGroundLevel': {
      // FlightHub 2 が地形データで作成した AGL。こちらの DEM と DJI 側の地形データは同一ではない。
      const absolute = ground === null ? null : ground + value;
      notes.push('FlightHub 2 の地形データ基準の AGL をそのまま地表からの高さとして表示しています');
      return { status: 'ok', agl: value, absolute, belowGround: value < 0, notes };
    }

    case 'realTimeFollowSurface': {
      // 機体のセンサーで地表（作物・樹冠を含む）に追従するため、計画時点で高さは確定しない。
      notes.push('リアルタイム地表追従は機体側で高さを決めるため、値を地表からの高さとみなした参考表示です');
      const absolute = ground === null ? null : ground + value;
      return { status: 'reference', agl: value, absolute, belowGround: false, notes };
    }

    default:
      notes.push(`高度モード「${heightMode ?? '未指定'}」は変換方法が仕様から確認できないため、空中には配置していません`);
      return { status: 'unsupported', agl: null, absolute: null, belowGround: false, notes };
  }
}

/** シンボル配置用の値。決まらない場合は地表（0）に置く。 */
export function symbolOffsets(r: AltitudeResult, ground: number | null): { heightAGL: number; heightAbs: number } {
  const g = ground ?? 0;
  if (r.agl !== null) return { heightAGL: r.agl, heightAbs: r.absolute ?? g + r.agl };
  return { heightAGL: 0, heightAbs: g };
}
