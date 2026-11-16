"""E1–E4 實驗共用模組。

設計原則：
- 會碰 AWS／資料庫的函式一律延遲 import（boto3、psycopg），乾跑（--dry-run）不需要安裝它們、也不需要憑證。
- 計算與分析是純函式（analysis.py），有單元測試。
- 實驗灌入的任務一律 target=replay；tasks.py 的守門函式在送出前逐則檢查。
- 程式碼要相容 Python 3.9（Amazon Linux 2023 預設的 python3）。
"""
