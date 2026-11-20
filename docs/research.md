# 仕様調査メモ

調査日: 2026-11-20。MapLibre GL JS は npm で公開されている各バージョンのソース（`src/`）とスタイル仕様（`@maplibre/maplibre-gl-style-spec@26.9.0` の `latest.json`）を直接確認した。DJI WPML は DJI Cloud API ドキュメント（v1.20 表示時点）を確認した。

## MapLibre GL JS

### symbol-height-offset

| 項目 | 内容 |
|---|---|
| 種別 | `layout` プロパティ（symbol レイヤー） |
| 型 / 単位 | number / メートル。既定値 0 |
| 意味 | アンカー（`symbol-height-anchor` で選ぶ基準面）からの高さにシンボルを置く |
| 条件 | `symbol-placement: "point"` のときのみ有効 |
| 式 | `zoom` と `feature` を参照可能（data-driven、補間可） |
| 対応バージョン | スタイル仕様の sdk-support で `js: 6.6.0`（基本機能・data-driven とも）。MapLibre Native は未対応（maplibre-native#1929） |

npm の各版のソースで `symbol-height-offset` を検索した結果:

| バージョン | 実装 |
|---|---|
| 6.5.0 | なし |
| 6.6.0 | 追加（`symbol_layout.ts` / `placement.ts` / `projection.ts` / `draw_symbol.ts` / `symbol_elevation.ts`） |
| 6.8.0 | 高い位置にあるシンボルが画面外のタイルに属していても読み込まれるよう、`tile_manager.ts` と `covering_tiles.ts` に「シンボルが到達しうる最大高さ」（`maxHeightOffset` / `maxContentElevation`）を考慮する処理が追加 |
| 6.18.0 / 6.19.0 | 6.8.0 と同じ構成 |

このアプリは 6.18 以降を前提にしている（`package.json` は `^6.19.0`）。

### symbol-height-anchor

| 値 | 意味 |
|---|---|
| `ground`（既定） | シンボル直下の地形の高さから測る。Terrain 無効時は 0 から |
| `absolute` | 海面（標高 0）から測る。シンボル直下の地形は無視 |

- `data-constant`（feature ごとには変えられない）。`zoom` は参照可能。
- スタイル仕様の sdk-support では JS 版が issue へのリンク（maplibre-gl-js#644）のままだが、6.6.0 のソースには実装がある（`placement.ts`、`draw_symbol.ts` で `symbol-height-anchor === 'ground'` を判定）。仕様書の表記と実装に差があるため、実際の動作は画面で確認した（[verification.md](./verification.md)）。

実装の中心は `src/symbol/symbol_elevation.ts` の 1 関数で、挙動はこれで決まる。

```ts
export function getSymbolElevation(getElevation, x, y, heightOffset, heightAnchorGround) {
    if (!heightAnchorGround) {
        return heightOffset;                     // absolute: offset がそのまま標高
    }
    if (!getElevation) {
        return heightOffset !== 0 ? heightOffset : undefined;  // Terrain なし: 0 + offset
    }
    return getElevation(x, y) + heightOffset;    // ground: 地形 + offset
}
```

`getElevation` は Terrain の誇張（exaggeration）を掛けた後の値を返すので、

- `ground` : 地形の高さだけが誇張され、offset は誇張されない
- `absolute`: offset（標高）は誇張されないため、誇張した地形に埋もれる

### 3D Terrain と queryTerrainElevation()

- `map.setTerrain({ source, exaggeration })` で有効化。`raster-dem` ソースの `encoding` は `mapbox` / `terrarium` / `custom`（線形結合）。
- 地理院の標高タイル（PNG）は 2 の補数表現と無効値（R,G,B = 128,0,0）を持つため `custom` では表せない。本アプリは `addProtocol` で Terrarium 形式に変換している（`src/terrain/browserDem.ts`）。
- `map.queryTerrainElevation(lngLat)` は「海抜メートル、誇張率を掛けた値」を返し、Terrain 無効時は `null`。値は描画中のタイルのズームに依存する。

### Custom Layer Interface と 3D ライン

- MapLibre の line レイヤーは頂点ごとの高さを持てない（地表に投影されるか、Terrain に沿って描かれる）。高さ付きの線は Custom Layer で描く必要がある。
- `renderingMode: '3d'` で MapLibre の深度バッファを共有し、地形の陰になった部分は隠れる。
- **v6 の注意点**: `render(gl, options)` に渡される `options.modelViewProjectionMatrix` はワールドピクセル座標用。`MercatorCoordinate`（0〜1）で頂点を置く場合は `options.defaultProjectionData.mainMatrix` を使う。前者を使うと何も表示されない。
- Three.js の `Line2` / `LineMaterial`（太線）は、投影行列の要素 `[2][3]` が −1 のときだけビュー空間で近クリップ面の処理をする。MVP×モデル行列をまとめて投影行列に入れる構成では、この処理が走らずクリップ空間で太さが付く。

## DJI WPML

出典: DJI Cloud API → API Reference → DJI WPML（Overview / Template.kml / Waylines.wpml / Common Elements）
https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/dji-wpml/common-element.html

### KMZ の構成

```
mission.kmz（ZIP）
└─ wpmz/
   ├─ template.kml    テンプレートファイル（編集用の業務パラメータ）
   ├─ waylines.wpml   実行ファイル（機体が実行する経路と動作）
   └─ res/            補助リソース（任意）
```

- 名前空間: KML は `http://www.opengis.net/kml/2.2`、WPML 拡張は `http://www.dji.com/wpmz/1.0.x`（バージョン違いがありうる）。
- `waylines.wpml` は `Folder` 1 つが実行可能な 1 本の経路。mapping3d テンプレートでは 5 本の Folder が生成される。

### 高さに関係する要素

| ファイル | 要素 | 内容 |
|---|---|---|
| waylines.wpml | `Folder/wpml:executeHeightMode` | `WGS84`（楕円体高）/ `relativeToStartPoint`（離陸地点相対）/ `realTimeFollowSurface`（リアルタイム地表追従。M3E/M3T/M3M のみ） |
| waylines.wpml | `Placemark/wpml:executeHeight` | ウェイポイントの実行高度 [m]。基準面は executeHeightMode で宣言 |
| waylines.wpml | `Placemark/wpml:waypointSpeed` | そのウェイポイントから次のウェイポイントへの速度 [m/s] |
| waylines.wpml | `Folder/wpml:autoFlightSpeed` | wayline 全体の目標速度 [m/s]（WP 側の定義が優先） |
| waylines.wpml | `Folder/wpml:waylineId`、`Placemark/wpml:index` | ID と通し番号（0 からの連番） |
| template.kml | `wpml:waylineCoordinateSysParam/wpml:heightMode` | `EGM96`（海抜）/ `relativeToStartPoint` / `aboveGroundLevel`（地形データによる AGL。FlightHub 2 のみ）/ `realTimeFollowSurface` |
| template.kml | `Placemark/wpml:height`、`wpml:ellipsoidHeight` | 同じ位置を heightMode の基準と楕円体高でそれぞれ表したもの |
| template.kml | `Folder/wpml:globalHeight` | 経路全体の高さ（`useGlobalHeight=1` の WP が使う） |
| template.kml | `missionConfig/wpml:takeOffRefPoint` | 参考離陸地点。**`緯度,経度,楕円体高` の順**（KML の coordinates と逆）。「実行時は実際の離陸地点が優先される」と注記あり |
| template.kml | `missionConfig/wpml:takeOffRefPointAGLHeight` | 参考離陸地点の高さ。説明文は「takeOffRefPoint の楕円体高に対応する」とだけあり、意味が確定できない |
| template.kml | `wpml:surfaceFollowModeEnable`、`wpml:surfaceRelativeHeight` | 地形追従（測量テンプレートのみ）の有無と対地高度 |
| 共通 | `missionConfig/wpml:takeOffSecurityHeight` | 安全離陸高度（離陸地点相対） |

### 機体コード

Cloud API の製品一覧では Mavic 3 Enterprise シリーズが `droneEnumValue = 77`、サブタイプ 0（M3E）/ 1（M3T）/ 3（M3TA）と記載されている。Mavic 3M（M3M）は WPML の対応機種には含まれるが、Cloud API の製品一覧には掲載がない。本アプリとサンプルでは M3M を `77-2`、ペイロード `68` として扱っているが、**実機 KMZ で確認が必要**。

## 高度基準の整理

| 基準 | 定義 | このアプリでの扱い |
|---|---|---|
| AGL（対地高度） | その地点の地表面からの高さ | `symbol-height-anchor: ground` の offset |
| 離陸地点相対高度 | 離陸地点からの高さ | 離陸地点の DEM 標高を足して標高に、さらに WP 直下の DEM 標高を引いて AGL に |
| 海抜高度（標高） | ジオイドからの高さ | 地理院 DEM と同じ基準。`symbol-height-anchor: absolute` の offset |
| 楕円体高 | WGS84 楕円体からの高さ | ジオイド高 N を引いて標高に。N が分からなければ換算しない |

- 地理院 DEM の標高は東京湾平均海面（日本のジオイド）基準。DJI の EGM96 とはジオイドモデルが異なり、差は 1m 程度以内と見込まれるが補正していない。
- 国土地理院のジオイド高計算サービスは CORS が許可されていない（`Access-Control-Allow-Origin` が `vldb.gsi.go.jp` のみ）ため、ブラウザから自動取得できない。ジオイド高は手入力とした。
- 参考値: 北緯 42.88° 東経 143.10° のジオイド高 29.4659 m、北緯 42.6745° 東経 143.036° は 29.5594 m（国土地理院 ジオイド計算サービスで取得）。
