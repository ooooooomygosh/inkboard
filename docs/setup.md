# 部署

从零到墨水屏亮起来，大约一个小时。顺序是：云端 → 编辑器 → 手机 → 阅读器 → Mac（可选）。

## 0. 准备

| 需要 | 说明 |
|---|---|
| Node.js 20+ | 构建前端、部署 Worker |
| Cloudflare 账号 | Workers 和 D1 的免费额度足够个人使用 |
| 大模型 API key | 默认 DeepSeek（OpenAI 兼容接口），在 `server/src/ai.ts` 顶部换成别家也行 |
| Android 墨水屏阅读器 | Android 8 及以上，能打开 USB 调试 |
| Android SDK build-tools、JDK 17 | 编译阅读器 App（不用 Gradle，也不用 Android Studio） |
| Mac（可选） | 监控 Agent、读邮件、读订阅额度 |

## 1. 云端

```bash
cd server
npm install
npx wrangler login
npx wrangler d1 create inkboard          # 记下输出里的 database_id
cp wrangler.toml.example wrangler.toml   # 把 database_id 填进去
npm run db:init:remote                   # 建表
```

生成三个口令，存成 Worker 的 secret：

```bash
for k in ADMIN_TOKEN DEVICE_TOKEN INGEST_TOKEN; do openssl rand -hex 24 | npx wrangler secret put $k; done
```

| 口令 | 谁用 |
|---|---|
| `ADMIN_TOKEN` | 你自己：登录编辑器和手机页 |
| `DEVICE_TOKEN` | 阅读器：只能读看板、点按 |
| `INGEST_TOKEN` | Mac 采集端：只能上传数据 |

想留一份本地副本，就把三行 `KEY=值` 写进 `server/.prod.vars`（已在 `.gitignore` 里）。

部署：

```bash
npm run deploy
```

输出里的 `https://inkboard.<你的子域>.workers.dev` 就是你的服务地址。Cron 每 5 分钟跑一次，拉天气、行情、日历、GitHub，并在固定时间生成简报和论文雷达。

### 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:init
npm run dev            # http://localhost:8787
```

## 2. 编辑器（`/admin`）

用 `ADMIN_TOKEN` 登录，按标签页设置：

- **设备 → 关于你**：城市、一两句自我介绍（会放进每次 AI 调用）、记账的两个名字和币种。
- **数据源**：
  - 大模型 API key；
  - 日历的 ICS 订阅链接（Outlook、Google、iCloud、飞书都能导出），云端每 15 分钟拉一次；
  - 可选：Google 日历和 Tasks（OAuth），GitHub 令牌（个人和组织各一个，只读权限即可），各家 API 的余额 key。
- **组件**：拖拽布局，每个组件右侧有属性面板。行情组件可以按名字搜股票、指数、汇率，中文名也能搜。
- **设备**：屏幕方向、前光时间表、电池保养、刷新频率、夜间模式、时区。

编辑器里的“📱 手机快速捕获”会给出二维码。

## 3. 手机

扫码打开 `/c`，登录一次，加到主屏幕。

- `/c` 今天：说出今天要做的事、回答 AI 的问题、勾待办、处理邮件、把事情交给 AI。
- `/m` 记账：见 [ledger.md](ledger.md)。另一位的专属链接在“设备 → 关于你”里复制。

## 4. 阅读器

具体改造见 [device.md](device.md)，最短路径是：

```bash
cd android
# 签名密钥：见 build.sh 开头的说明；放进 android/keys/
./build.sh --install
adb shell am start -n com.inkboard/.MainActivity \
  --es server https://inkboard.<你的子域>.workers.dev \
  --es token <DEVICE_TOKEN> \
  --es timezone Asia/Shanghai \
  --es reader <你的阅读 App 包名，可省略>
adb shell cmd package set-home-activity com.inkboard/.MainActivity
```

想让阅读器开机直接进看板、隐藏不用的系统应用：

```bash
cp debloat.example.txt debloat.txt   # 按 adb shell pm list packages 的结果改
./debloat.sh                         # 随时可以 ./restore.sh 恢复
```

阅读器每 30 秒同步一次，有 Agent 在跑时 10 秒一次。长按屏幕左上角 2 秒，或在编辑器里点“弹出菜单”，可以打开 Wi-Fi 设置、强制全刷、打开阅读 App。

## 5. Mac 采集端（可选）

```bash
./mac/install.sh https://inkboard.<你的子域>.workers.dev <INGEST_TOKEN>
./mac/setup-permissions.sh     # 依次弹出系统权限窗口，点“允许”
```

安装内容：

- `~/.inkboard/`：脚本和配置 `config.env`；
- Claude Code（`~/.claude/settings.json`）和 Codex（`~/.codex/hooks.json`）的异步钩子；
- launchd 任务：额度采集（每 3 分钟）、Helper（每 10 分钟，邮件、日历、笔记、定位）；装了 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 时再加一个桥接任务（桌面 App 会话、后台代办、DeepSeek Harness）。

Codex 需要信任钩子：在终端运行一次 `codex`，输入 `/hooks`，信任 InkBoard 的钩子。信任记录在 `~/.codex/config.toml`，Codex 桌面版共用。

`~/.inkboard/config.env` 里的常用开关：

| 键 | 作用 |
|---|---|
| `MAIL_SYNC=1` | 读苹果“邮件”里的邮件 |
| `MAIL_DOMAIN=example.edu` | 只看发给或来自这个域名的邮件，比如学校或公司；留空就是整个收件箱 |
| `MAIL_DAYS=3` | 往回看几天 |
| `CALENDAR_SYNC=1` | 读 macOS 日历（用了 ICS 链接就不需要） |
| `LOCATION_SYNC=1` | 用 Mac 的精确定位给天气用 |
| `NOTES_DIRS=~/notes:~/papers` | 研究笔记所在的文件夹，给研究焦点和论文雷达用 |
| `SHARE_PROMPT_TITLE=1` | 把提示词的前 30 个字作为会话标题上传（默认不上传提示词） |
| `SSH_HOST_LABEL=实验室服务器` | SSH 会话在看板上显示的主机名 |

改完重新运行一次 `install.sh`，已有的设置会保留。卸载：`./mac/uninstall.sh`。

订阅额度通过 [CodexBar](https://github.com/steipete/CodexBar) 的命令行读取，装了它才有 Claude、Codex 等订阅的额度卡片。

## 6. 远程服务器上的 Agent

在服务器上也跑 Claude Code 的话，把 `mac/inkboard_hook.py` 拷过去，在 `~/.inkboard/config.env` 写上 `WORKER_URL`、`INGEST_TOKEN` 和 `HOST_LABEL`，再在服务器的 `~/.claude/settings.json` 里加上和 Mac 一样的钩子（见 `install.sh` 里的 `merge` 部分）。钩子只需要 Python 3.6+，不需要额外依赖。

## 常用命令

```bash
cd server && npm run deploy                       # 部署云端和前端
cd server && npm run typecheck                    # 类型检查
cd android && ./build.sh --install                # 编译并安装阅读器 App
./mac/install.sh <WORKER_URL> <INGEST_TOKEN>       # 重新安装 Mac 采集端
python3 ~/.inkboard/helper_sync.py mail notes     # 立刻同步邮件和笔记
```
