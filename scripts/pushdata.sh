#!/usr/bin/env bash
# 统一的 data 分支发布脚本
#
# 为什么必须统一：
#   原来的做法是每个 workflow 在开始运行时把 data 分支的文件拷进 out，
#   跑完再「git init 孤儿提交 + force push」。两个问题：
#     1) 谁的两份拷贝旧，谁最后推，就把别人的新数据冲掉（丢更新）；
#     2) 只要某个 workflow 只关心自己的产物、拷贝清单没列全，
#        就会把没列到的文件整批删掉 —— 股票快照曾经因此抹掉全部基金数据。
#   现在统一成：先 clone 最新的 data 分支，再把本地产物覆盖上去，普通 push，
#   失败就重试。这样「没产出新版本的文件」会被原样保留，互不覆盖。
#
# 用法：GITHUB_TOKEN=xxx bash scripts/pushdata.sh out

set -euo pipefail

SRC="${1:-out}"
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

  # 用本次产物覆盖分支上的文件；分支上其它文件原样保留
  cp -f "$SRC"/* .data-push/ 2>/dev/null || true

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
