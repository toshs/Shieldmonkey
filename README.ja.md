[![CI](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/ci.yml)
[![Test](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/test.yml/badge.svg)](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/test.yml)
[![GitHub last commit](https://img.shields.io/github/last-commit/Shieldmonkey/Shieldmonkey?style=flat-square)](https://github.com/Shieldmonkey/Shieldmonkey/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/Shieldmonkey/Shieldmonkey?style=flat-square&color=blue)](https://github.com/Shieldmonkey/Shieldmonkey/issues)
[![License](https://img.shields.io/github/license/Shieldmonkey/Shieldmonkey?style=flat-square&color=orange)](LICENSE)


[English README](README.md)

![Shieldmonkey](assets/header.jpeg)

# Shieldmonkey

Shieldmonkeyは、セキュリティと監査可能性を最優先に設計された、オープンソースでManifest V3準拠のユーザースクリプトマネージャーです。

## 設計と特徴

![Shieldmonkey Architecture](assets/architecture_diagram.png)

### 強固なセキュリティポリシー (CSP)
Shieldmonkeyは、拡張機能自身が外部と意図しない通信を行うことを防ぐため、厳格なContent Security Policy (CSP) を設定しています。
Background Scriptや各ページからの外部接続は遮断されます。これに伴い、以下の機能は意図的に排除されています。

- `GM_xmlHttpRequest` などのCORSを回避する関数
- `require` による外部スクリプトの動的読み込み
- クラウドサービスへの自動バックアップ
- スクリプトの自動更新

全ての更新はユーザーの手動操作によってのみ行われ、バックグラウンドでの意図しないコードの書き換えや実行を防ぎます。

### 監査可能なビルド
透明性を確保するため、以下のビルド方針を採用しています。

- ビルドされた拡張機能のソースコードは、監査のしやすさを優先し、意図的にMinify（圧縮・難読化）を行っていません。
- デバッグと検証のためにSourceMapを同梱しています。
- 配布サイズを考慮したMinify版も提供されますが、非Minify版の利用を推奨します。

監査可能性とコントロールを重視するユーザーのために、GitHubからの手動インストールを選択肢として提供しています。ブラウザストアによる審査と利便性を取るか、ソースコードからビルドされた固定バージョンの透明性を取るか、ユーザー自身が選択できます。

### サプライチェーンの安全性
pnpmの設定 (`pnpm-workspace.yaml`) と厳格なバージョン管理により、サプライチェーン攻撃への耐性を高めています。

- **厳格なバージョン固定 (package.json)**: `package.json` 内のすべての依存関係は、範囲指定（`^`や`~`）を使用せず、完全な固定バージョンで記述されています。これにより、ビルドごとの差異を排除します。
- **`pnpm-workspace.yaml` による保護**:
  - **`blockExoticSubdeps=true`**: Git URLなど、npmレジストリ以外からの依存関係のインストールをブロックし、信頼できないソースからのコード混入を防ぎます。
  - **`minimumReleaseAge=10080`**: 公開から7日以上経過したパッケージのみをインストールします。これにより、公開直後の悪意ある更新（Zero-day攻撃）やTyposquattingのリスクを軽減します。
  - **`trustPolicy=no-downgrade`**: 依存パッケージが密かに古いバージョンへダウングレードされることを防ぎます。
- **`ignore-scripts`**: `pnpm` ではデフォルトでスクリプトの自動実行が無効化されていますが、`.npmrc` にもフォールバックとして `ignore-scripts=true` を記述し、npm使用時でも悪意あるスクリプトが実行されないようにしています。
- **不変のロックファイル**: `lockfile=true` を強制し、CIでは `pnpm install --frozen-lockfile` を使用することで、再現性のあるビルドを保証します。

## 機能

- スクリプトの管理（インストール、編集、削除、無効化）
- CodeMirror 6による編集環境
- `.user.js` 形式への対応
- ローカルへのインポート・エクスポート

## 技術スタック

- React 19
- Vite (w/ CRXJS)
- TypeScript
- CodeMirror 6
- IndexedDB
- Vanilla CSS / Sass

## インストールとビルド

1. リポジトリのクローン
   ```bash
   git clone https://github.com/shieldmonkey/shieldmonkey.git
   cd shieldmonkey
   ```

2. 依存関係のインストール
   `.npmrc` により `ignore-scripts=true` が設定されているため、以下のコマンドで安全にインストールできます。
   ```bash
   pnpm install
   ```

3. ビルド
   ```bash
   pnpm run build
   ```

4. 拡張機能の読み込み
   Chromeの `chrome://extensions` を開き、デベロッパーモードを有効にして、生成された `dist` ディレクトリを読み込んでください。

### Android版Vivaldi

Android版Vivaldiでフォルダーから読み込む場合は、専用ビルドを使います。Vivaldiのフォルダー選択経由では `_locales` を含む通常ビルドを読み込めないため、専用ビルドはマニフェストの名前と説明を直接指定し、翻訳フォルダーを除きます。画面内の日本語・英語の翻訳はビルド済みJavaScriptに含まれます。

```bash
pnpm run build:vivaldi
adb push dist-vivaldi /sdcard/Download/ShieldMonkeyVivaldi
```

Vivaldiの `vivaldi://extensions` でデベロッパーモードを有効にし、「非パッケージ拡張機能を読み込む」で `Download/ShieldMonkeyVivaldi` フォルダーを選択します。読み込み後、拡張機能の「詳細」で「ユーザー スクリプトを許可する」を有効にしてください。

設定で空のフォルダーを選ぶと、`scripts/` に編集可能な `.user.js`、`state.json` にIDと設定、`history/` に変更履歴を保存します。既にこの形式の `state.json` があるフォルダーを選んだ場合は、設定の「復元」から読み込みます。旧形式の `shieldmonkey_dump.json` だけがあるフォルダーは選べません。

```text
ShieldMonkey/
├── scripts/
│   ├── GitHub.user.js
│   └── 開発/管理画面.user.js
├── state.json
└── history/
    └── 2026-10-03T09-15-30-000Z-xxxxxxxx.json
```

アプリ内の保存・移動はフォルダーへ毎回反映されます。外部でファイルを編集・改名した場合はスクリプト一覧を開くか「ファイルを再読込」を押すと反映されます。双方を編集した場合は差分を確認して採用する版を選べます。ファイルを外部で削除した場合も確認が必要です。履歴は件数制限なく蓄積され、全体または１本を復元できます。Vivaldi再起動後などに権限が切れた場合は設定から再許可してください。単一JSONファイルの入出力は引き続き利用できます。

## テスト

E2Eテストを実行してShieldmonkeyの機能を検証できます。

```bash
# Playwright Browsersをインストール（初回のみ）
pnpm exec playwright install chromium --with-deps

# 拡張機能をビルド
pnpm run build

# E2Eテストを実行
pnpm run test:e2e
```

テストには以下が含まれます：
- スクリプトのインストールとインポート
- オプションページでのスクリプト管理（作成、編集、削除）
- バックアップとリストア機能
- CSPポリシーの検証
- ポップアップページの動作確認
