#!/usr/bin/env bash
# 统一的 data 分支发布脚本
#
# 为什么必须统一：
#   原来的做法是每个 workflow 在开始运行时把 data 分支的文件拷进 out，
#   跑完再「git init 孤儿提交 + force push」。两个问题：
#     1) 谁的两份拷贝旧，谁最后推，就把别人的新数据冲掉（丢更新）；
#     2) 只要某个 workflow 只关心自己的产物、拷贝清单没列全，
#        就会把没列到的文件整批删掉 —— 股票快照曾经因此抹掉全部基金数据。
#   现在统一成：先 clone 最新的 data 分支，再把**本次产出的文件**覆盖上去，
#   普通 push，失败重试。没产出的文件原样保留。
#
# 参数必须显式列出本次产出的文件（相对 out/ 的文件名）。
# 不能整个目录覆盖：各 workflow 会把别人的产物读进 out/ 当输入用，
# 若一起推上去，就会用旧副本把别人刚写的新版本降级。
#
# 用法：GITHUB_TOKEN=xxx bash scripts/pushdata.sh funddetail.json

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "必须指定要发布的文件名，例如：pushdata.sh funddetail.json" >&2
  exit 1
fi

SRC="out"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d "$SRC" ]; then
  echo "产物目录 $SRC 不存在" >&2
  exit 1
fi

REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

for attempt in 1 2 3 4; do
  rm -rf .data-push
  if git clone --depth=1 -b data "$REMOTE" .data-push 2>/dev/null; then
    :
  else
    mkdir -p .data-push
    git -C .data-push init -q -b data
    git -C .data-push remote add origin "$REMOTE"
  fi

  for f in "$@"; do
    if [ -f "$SRC/$f" ]; then
      cp -f "$SRC/$f" ".data-push/$f"
      echo "发布 $f ($(wc -c < "$SRC/$f") 字节)"
    else
      echo "警告：$SRC/$f 不存在，跳过" >&2
    fi
  done

  (
    cd .data-push
    git config user.name "guxi-snapshot-bot"
    git config user.email "bot@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then
      echo "没有变化，跳过提交"
      exit 0
    fi
    git commit -q -m "data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if git push origin data 2>/dev/null; then
      echo "已推送：$(ls -1 | tr '\n' ' ')"
      exit 0
    fi
    echo "第 $attempt 次推送冲突，重试…" >&2
    exit 1
  ) && exit 0

  sleep $((attempt * 3))
done

echo "推送 data 分支失败" >&2
exit 1
