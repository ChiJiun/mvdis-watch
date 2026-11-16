#!/bin/sh
# LocalStack 健康檢查：所有 init/ready.d 腳本都跑完、而且沒有失敗才回 0。
# 只用 curl＋grep，不啟動 awslocal（Python CLI 每次約 2 秒 CPU）。
s=$(curl -sf http://localhost:4566/_localstack/init/ready) || exit 1
echo "$s" | grep -Eq '"completed": ?true' || exit 1
# 任一腳本不是 SUCCESSFUL（ERROR、還在跑等）都算不健康
if echo "$s" | grep -Eq '"state": ?"(ERROR|UNKNOWN|RUNNING|INITIALIZED)"'; then exit 1; fi
echo "$s" | grep -Eq '"state": ?"SUCCESSFUL"' || exit 1
exit 0
