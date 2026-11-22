# データ仕様

KMZ を読み込んでから地図に表示するまでのデータの流れと、各段階のデータ形式。

```
KMZ ──JSZip──▶ waylines.wpml / template.kml ──DOMParser──▶ ParsedMission
     ──DEM サンプラー + 高度変換──▶ ResolvedWaypoint[] ──▶ GeoJSON ──▶ MapLibre
                                                     └─▶ Three.js 3D ライン / 飛行タイムライン
```

すべてブラウザ内で処理する。KMZ をサーバーに送ることはない。外部へのリクエストは地理院タイル（地図・標高）と MapLibre デモのフォント（数字ラベル用）だけ。

## 1. 解析（src/wpml/parser.ts）

### 読み込むファイル

1. KMZ 内で名前が `waylines.wpml` で終わるファイル（通常 `wpmz/waylines.wpml`）
2. 1 がなければ `template.kml` から取得できる範囲で読む
3. どちらの場合も `template.kml` があれば離陸地点（`takeOffRefPoint`）とテンプレート情報を読む

要素は「直下の子要素のローカル名」で探す。名前空間 URI のバージョン（`wpmz/1.0.2`、`1.0.6` など）や接頭辞が違っても読める。アクション（`wpml:actionGroup`）内の要素とウェイポイントの属性を取り違えないよう、子孫要素の検索はしない。

### ParsedMission

| フィールド | 内容 |
|---|---|
| `source` | ウェイポイントを取り出したファイル（`waylines.wpml` / `template.kml` / `null`） |
| `files` | KMZ 内のファイル一覧 |
| `wpmlNamespace` | wpml 名前空間 URI |
| `missionConfig` | 機体コード、安全離陸高度、終了時動作など |
| `takeoffRef` | `{ lat, lng, ellipsoidHeight, aglHeight }`（template.kml のみ） |
| `waylines[]` | wayline ごとのウェイポイント |
| `templateFolders[]` | テンプレート種別、heightMode、測量エリアのポリゴンなど |
| `warnings[]` | 欠落した要素など、解析時の注意 |

### WaypointRecord（1 ウェイポイント）

| フィールド | waylines.wpml | template.kml |
|---|---|---|
| `waylineId` | `Folder/wpml:waylineId`（なければ出現順） | `Folder/wpml:templateId` |
| `index` | `wpml:index` | `wpml:index` |
| `lng`, `lat` | `Point/coordinates` | `Point/coordinates` |
| `executeHeight` | `wpml:executeHeight` | `wpml:height`（`useGlobalHeight=1` なら `wpml:globalHeight`） |
| `heightMode` | `Folder/wpml:executeHeightMode` | `wpml:waylineCoordinateSysParam/wpml:heightMode` |
| `ellipsoidHeight` | なし（null） | `wpml:ellipsoidHeight` |
| `waypointSpeed` | `wpml:waypointSpeed`、なければ `autoFlightSpeed` | 同左（`useGlobalSpeed=1` なら `autoFlightSpeed`） |
| `speedSource` | `waypoint` / `wayline` / `none` | 同左 |

## 2. 地表標高（src/terrain/gsiDem.ts）

- 国土地理院 標高タイル（`dem_png`、z14）を取得して双線形補間する `DemSampler`。
- 高度変換はこのサンプラーの値を使う。`map.queryTerrainElevation()` は描画中のタイルのズームで値が変わり、Terrain 無効時は使えないため。
- 検証タブで両者を比較できる。

## 3. 高度変換（src/altitude/altitude.ts）

入力: 高度モード、ファイル上の値、WP 直下の地表標高、離陸地点の地表標高、ジオイド高 N（任意）

| 高度モード | 標高（abs） | 地表からの高さ（AGL） | 状態 |
|---|---|---|---|
| `relativeToStartPoint` | 離陸地点標高 + 値 | abs − WP 地表標高 | 確定。離陸地点を仮定した場合は参考 |
| `WGS84` | 値 − N | abs − WP 地表標高 | N 入力時は確定。未入力なら換算せず参考（地表に配置） |
| `EGM96`（template のみ） | 値 | abs − WP 地表標高 | 確定（ジオイドモデルの差は未補正と注記） |
| `aboveGroundLevel`（template のみ） | WP 地表標高 + 値 | 値 | 確定（DJI 側の地形データとの差は未補正と注記） |
| `realTimeFollowSurface` | WP 地表標高 + 値 | 値 | 参考（機体が実時間で決めるため） |
| その他・未指定 | — | — | 未対応（地表に配置） |

離陸地点の決め方: 地図で指定した地点 > `takeOffRefPoint` > 最初のウェイポイント直下（仮定、参考扱い）。

`takeOffRefPointAGLHeight` は仕様上の意味が確定できないため換算に使わず、値があれば画面に注記する。

## 4. GeoJSON（src/wpml/geojson.ts）

### ウェイポイント（Point）

| プロパティ | 型 | 内容 |
|---|---|---|
| `id` | string | `"{waylineId}-{index}"` |
| `waylineId`, `index` | number | |
| `label` | string | 地図に出す番号 |
| `executeHeight`, `heightMode` | number, string | ファイル上の値 |
| `waypointSpeed` | number \| null | m/s |
| `groundElevation` | number \| null | WP 直下の DEM 標高 |
| `heightAGL` | number | `symbol-height-anchor: ground` で使う値。決まらない場合 0 |
| `heightAbs` | number | `symbol-height-anchor: absolute` で使う値。決まらない場合は地表標高 |
| `status` | `ok` / `reference` / `unsupported` | アイコンの形を切り替える |
| `belowGround` | boolean | 換算後に地表より下 |
| `colorIndex`, `color` | number, string | wayline ごとの色 |
| `heightLabel` | string | 高さラベル（`"60m"`、未確定は `"?"`） |

### 経路（LineString）

wayline ごとに WP を index 順につないだ線。プロパティは `waylineId`、`color`。地表に投影した 2D 表示に使う。

### 測量エリア（Polygon）

template.kml の測量テンプレート（mapping2d 等）のエリア。

## 5. MapLibre のレイヤー（src/map/mapView.ts）

```js
{
  id: 'wp-symbol',
  type: 'symbol',
  source: 'mission',
  layout: {
    'icon-image': [...],                         // status と wayline の色で切り替え
    'symbol-height-offset': ['get', 'heightAGL'], // absolute のときは 'heightAbs'
    'symbol-height-anchor': 'ground',             // 'absolute' と切り替え可能
    'icon-allow-overlap': true,
    'symbol-sort-key': ['-', 0, ['get', 'heightAbs']],
    'text-field': ['get', 'label']
  }
}
```

3D ラインの頂点の高さもシンボルと同じ規則で決める（`src/main.ts` の `renderHeights`）。

| | Terrain あり | Terrain なし |
|---|---|---|
| ground | 地表標高 × 誇張率 + heightAGL | heightAGL |
| absolute | heightAbs | heightAbs |

## 6. 飛行タイムライン（src/animation/timeline.ts）

- 区間ごとの所要時間 = 3 次元距離 ÷ 速度（開始側 WP の `waypointSpeed`、なければ 5 m/s と仮定して画面に表示）
- 高さは標高を直線補間し、表示用 AGL は現在地の DEM 標高を引いて求める
- 加減速・旋回・ホバリング・撮影などの動作は含まない。実際の飛行軌跡・時間ではない

## サンプル KMZ（public/samples/）

`npm run samples` で再生成する（地理院 DEM を取得するためネットワークが必要）。

| ファイル | 内容 | 目的 |
|---|---|---|
| `flat-relative.kmz` | 帯広市西部の畑地、離陸地点相対 60m、ジグザグ 8 WP | 平坦な地形 |
| `hilly-relative.kmz` | 帯広市拓成町付近、谷から尾根へ、離陸地点相対 150m | 起伏のある地形、地表より下になる WP |
| `multi-wayline-wgs84.kmz` | 2 wayline、楕円体高、対地 30〜120m | 複数 wayline、異なる高度、ジオイド高 |
| `mixed-height-modes.kmz` | 離陸地点相対 / 地表追従 / 未知のモード | 異なる高度モード |
| `template-only-egm96.kmz` | template.kml のみ、EGM96 | waylines.wpml がない場合 |
| `template-only-mapping2d.kmz` | template.kml のみ、測量エリア | 経路を持たないテンプレート |

機体情報は Mavic 3M を想定して `droneEnumValue=77`、`droneSubEnumValue=2`、`payloadEnumValue=68` としている（実機ファイルで要確認）。
