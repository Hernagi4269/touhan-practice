登録販売者 過去問エンジン v2.0.0

主な変更
- TKDBを唯一の知識データとして使用
- 学習状況JSONとTKDB JSONを分離管理
- 対応ブラウザではFile System Access APIで選択ファイルを再利用
- 非対応ブラウザでは従来のファイル選択へ自動フォールバック
- IndexedDBへTKDBキャッシュとファイルハンドルを保存
- データカードを省スペース化し、読込状態・更新時刻・件数を表示
- window.TouhanTKDB.getKnowledge() / getQuestionKnowledge() を追加
- 生成JSONのengineVersionを2.0.0へ更新

注意
- ブラウザのセキュリティ仕様により、権限が失効した場合は「更新」または「選択」が必要です。
- ブラウザ実操作は未確認です。
