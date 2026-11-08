# Android Vivaldi の再有効化と `_metadata`（0.4.3）

0.4.2 の通信ルールは manifest の `declarative_net_request.rule_resources` で静的に登録していました。Android Vivaldi では読み込み先に `_metadata/generated_indexed_rulesets/_ruleset1` が生成されます。配布 ZIP から `_metadata` を除くだけでは、読み込み後に再生成されるため解決しません。

0.4.3 の Vivaldi ビルドでは静的ルールの宣言を外し、同じ `src/rules.json` のルールを `updateDynamicRules` で登録します。既存の拡張ページの外部ナビゲーション制限（ID 2）も維持します。動的ルールはブラウザーの再起動・拡張の更新をまたいで保持される API です。[Chrome API リファレンス](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#dynamic-and-session-scoped-rulesets)

バックグラウンドの起動時に登録するため、スクリプトの再登録やユーザースクリプト権限の確認が失敗しても通信ルールの設定を妨げません。Chrome / Firefox の通常ビルドは静的ルールを維持し、動的ルールを二重登録しません。Vivaldi のビルド後処理・ZIP 作成では静的ルールの宣言が残っていたらエラーにします。

## 更新

[更新手順](vivaldi-update-ja.txt) に従い、現在読み込んでいるフォルダーに上書きします。0.4.2 以前が生成した `_metadata` だけは、この更新時に一度削除してください。以後、この静的ルールのキャッシュを再生成する構成は使いません。ZIP 名は `Shieldmonkey-vivaldi.zip`、直下は `manifest.json` のままです。読み込み先の改名・移動や拡張の削除は不要です。

## 検証

Android 15 / API 35 のエミュレータ、Vivaldi 8.3.4192.64 で確認しました。Samsung 実機での確認は未実施です。

- 0.4.2 の読み込み先・拡張 ID を維持して 0.4.3 へ上書きし、スクリプト・設定と検証用データの保持を確認。
- 修正版の転送後はファイルを削除せず、無効化→再有効化→再読み込みを API 経由で3回連続実行。毎回 ENABLED、同じ ID・パス、manifest / runtime error は0件。
- ブラウザーを完全終了して再起動し、同じ ID の有効状態と `_metadata` の非生成を確認。
- 実画面のトグルでも無効化・再有効化を確認し、拡張の設定画面を開けることを確認。検証した Vivaldi では一覧の表示が古いまま残る場合があり、無効化後に一覧ページを更新してから再有効化した。
- 最終確認時も `_metadata` は存在せず、動的ルール ID 1・2 を取得できた。
- ブラウザーの `testMatchOutcome` で `.user.js?version=2` のヘッダールール、通常の `.js` が対象外、拡張からの外部フレーム制限、GitHub の例外、通常ページのナビゲーションが対象外、の5パターンを確認。
- 型検査・lint、49件のユニットテスト、Chrome / Vivaldi の本番ビルドが成功。

修正前のエミュレータではキャッシュの生成を確認できましたが、ユーザーの実機と同じエラーダイアログまでは再現していません。今回はキャッシュを生成する構成そのものを取り除いて検証しました。
