# 0.5.0 検証記録

検証日: 2026-11-09。製品コードの検証対象: `99248c14a7d9aea25be2c9f8d5701fda2f8d566a`。

- TypeScript / ESLint: 成功。
- 単体テスト: 70 件成功。権限追加と対象変更、非対応 API、GM の分離・失効・再接続、構文による初期化の回避、移行、バックアップと履歴を含む。
- [Linux CI](https://github.com/toshs/Shieldmonkey/actions/runs/42612765005): E2E 22 件成功（Chromium 21 件 + Firefox 1 件）。Firefox 157.0 の一時プロファイルで、拡張ロード、任意権限、個別 world、GM 保存値のページ再読み込み後の保持、CSP を確認。
- Chrome / Firefox / Android Vivaldi の production build: 成功。

## Android

Android 15 API 35 の専用エミュレーター、Vivaldi 8.3.4192.64 で確認。Samsung 実機での確認ではない。

- 読み込み先 `/sdcard/Download/ShieldMonkey/20261107-031126` と拡張 ID `akpfafjodcmdhokiebbfiaicinofkfob` を維持。
- 0.4.3 形式から設定・スクリプト ID・旧 GM 値を保持し、内部トークンのみ更新。
- 同じページに 13 本を対象登録し、本文の実行が 10 本に留まり、他 world の変数を参照できないことを確認。超過分は共有 world で実行されない。
- 最終ビルドで認証後の GM 初期化に成功。ページの `window.GM` は undefined、サイトの `sm_cache_` キーは 0 件。
- 実際の権限確認でキャンセル時の状態保持、許可後の有効化を確認。GM 権限を追加した同期内容は、未承認のまま無効化された。
- 編集破棄の確認で、キャンセル時の編集保持と、確定後の一覧への復帰を確認。
- 下部拡張メニューから popup を開き、アイコン・トグルと縦横表示を確認。管理画面は 411 px / 914 px の幅で横へのはみ出しなし、sandbox iframe なし。
- 再有効化・再読み込み 3 回とブラウザー再起動を確認。静的 DNR はなく、動的ルールは ID 2 のみ。
- 検証用スクリプトと GM 値を削除し、元の空のライブラリーへ復帰。

## 配布物

`Shieldmonkey-vivaldi.zip`、1,998,713 bytes。
SHA-256: `4a24a4757d0ad664c08c2d7b58ed1a5028812208d89d5c5aedec7ac30e26ad8f`。

ZIP 内の全製品ファイルと最終 `dist-vivaldi` のバイト一致、manifest version 0.5.0、ZIP の破損なしを確認。直下に manifest.json があり、バージョン付き親フォルダー、_locales、_metadata、旧 sandbox は含まない。
