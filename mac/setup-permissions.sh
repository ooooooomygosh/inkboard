#!/usr/bin/env bash
# One-time: trigger every macOS permission prompt InkBoard Helper needs, then sync once.
# Click "Allow" on: Downloads folder, Calendar (full access), Location, and (if MAIL_SYNC=1) controlling Mail.
set -uo pipefail
echo "InkBoard 需要这几个权限，弹窗出现时点“允许”："
echo "  1) 访问“下载”文件夹（读研究笔记）  2) 日历完全访问（如开启日历同步）  3) 定位（精确天气）  4) 控制“邮件”（如已开启邮件同步）"
python3 "$HOME/.inkboard/helper_sync.py" events notes location mail
echo "完成。之后每 10 分钟自动同步，日志：~/Library/Logs/InkBoard/helper.log"
