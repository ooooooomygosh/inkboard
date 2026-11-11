# 做 AI 高手 · 团队开发台

独立于个人 InkBoard 的 Cloudflare Worker、D1 与 Queues。仅接收绑定群；固定管理 OmnixSI 四个仓库。模型为 `deepseek-flash`，聊天 high，方案、记忆和本机编码 max。

## 使用

- 云端看板：部署输出的 workers.dev 地址。成员通过“用 QQ 群登录”验证群成员身份，领取自己的可撤销访问凭证；也支持一次性邀请。
- 本机管理员入口：`http://127.0.0.1:3391`。管理员代理仅监听回环地址，凭据不会放进网页。
- 自然说话即可，不必 @ 或记完整仓库名；high 快速队列接话，max 夜间整理记忆和反思，纠正会关闭旧事实版本并保留证据。闲聊可以玩梗、吐槽和适量粗口，正式工作切换清楚准确的语气。
- 群内链接可实时搜索、读取；文件任务由独立 utility Agent 整理 CSV / XLSX / PDF / 公开视频，交付实际附件。复杂开发交给成员本机 AI。
- 每五分钟同步实际 CI；去重提醒失败。悉尼时间每天 12、19 点按项目情况检索新技术，附来源分享。
- `/方案 WhalePartner 需求`：整理方案；也支持完整仓库名和其余三个仓库的名称。
- `/开工 WhalePartner 需求`：先出方案，再由本机在独立 worktree 开发。两轮无法通过验证就保留接力材料。
- 普通讨论、引用、转发不触发写代码。接手任务时用“复制给本机 AI”，人工完成后回填状态。

## 部署与检查

先在 `server/` 执行 `npm ci`，团队服务复用其 Wrangler、TypeScript、esbuild 工具。

```sh
cd team
npm test
npm run check
cp wrangler.toml.example wrangler.toml
# 用自己的账户创建专用 D1 和队列，在 wrangler.toml 填团队 database_id。
../server/node_modules/.bin/wrangler d1 execute inkboard-team --remote --file=schema.sql
# 通过 wrangler secret bulk 或 secret put 配置服务端凭据。
npm run deploy
```

先创建 `inkboard-team`、`inkboard-team-chat` 两条免费档队列：聊天队列与慢任务分开消费，均使用 1 秒 batch timeout。

必需 secrets：ADMIN_TOKEN、RUNNER_TOKEN、DEEPSEEK_API_KEY；QQ 接通后再配置 QQ_APP_ID、QQ_APP_SECRET。不要复制个人 InkBoard 的管理口令。本机 GitHub 登录只用于同步仓库资料和提交任务分支，GitHub 令牌不上云。

QQ 官方回调地址为部署域名下 `/api/qq/events`。配置成功后，使用“管理接入”生成绑定码，由群主在目标群发 `/绑定 <码>`，并开启获取全量消息、主动发言。界面只有收到普通群消息才显示全量验证成功。若先使用本机官方 QQ 网关，它只转发消息，模型和看板仍在云端；电脑离线将暂停接收。

## 本机运行

运行配置在 `~/.inkboard-team/`，权限为 0700；私密 JSON 文件为 0600，均不进入仓库。

- `bridge.py`：出站领取云端任务、续租、发事件给本机 agent-autoloop、回填结果、同步四仓资料。
- `execute.py`：由专用 autoloop 规则启动 DSH，固定 Flash max 和 workspace-write；验证后提交分支和草稿 PR。合并和发布由成员完成。
- `qq-gateway.mjs`：官方 QQ SDK 的本机收信入口，落盘重试后转发到 Worker，不处理其他群的业务。
- `owner.py`：本机管理台代理。
- `utility.py`：独立资料助手，DSH Flash high（重要资料任务才 max）；隔离输入输出，使用 pypdf、openpyxl、ffmpeg、yt-dlp，交付目录由 QQ 官方 SDK 发送原生文件。默认不读取浏览器 cookie。

本次安装的 launchd 服务：`com.inkboard.team-runner`、`com.inkboard.team-qq`、`com.inkboard.team-owner`、`com.inkboard.team-utility`、`com.inkboard.team-utility-quick`。服务在用户登录后启动，退出桌面应用不影响它们。日志在 `~/.inkboard-team/`；可用 `launchctl kickstart -k gui/$(id -u)/<服务名>` 重启。

## 验证边界与恢复

集成测试覆盖签名、配对、目标群隔离、重复投递、成员撤销、并发领取、人工更新保护及模型档位。云端任务、聊天、记忆持久保存在 D1；队列只负责唤醒，cron 恢复未处理任务。模型失败最多重试三次。代码任务最多两轮修复。

本机任务完成后，再次核对租约与版本才推送；人工改动的任务不被旧结果覆盖。租约中断转人工接手，不自动重开代码任务。网络发送结果不明确时保留 unknown，不盲目重发群消息。

本机自动验证支持根目录含 test 脚本的 Node 项目、WhalePartner 的 apps/api 测试，以及纯文档变更。其他项目的构建、原生应用签名和运行环境需由成员配置对应验收命令；未能自动验收时交接，不声称通过。源码层未实现全盘代码索引，方案参考同步的 README、协作规则、记忆文档、Issue 和 PR；实施 Agent 在工作副本继续核对代码。

云端 Webhook、实际代码任务的草稿 PR、断线重启和 24 小时连续运行，应分别验收并记录实际结果，不能以单元测试代替。

## 文件助手与能力边界

本机创建 `~/.inkboard-team/venv` 并安装 `pypdf openpyxl`；PATH 包含 ffmpeg、ffprobe、yt-dlp 和 DSH。utility 的 launchd 与其他服务相同，程序参数为 Python 和 utility.py。单文件 50 MB、最多 5 个输出；公开视频最多抽 6 帧，字幕可用才读取。扫描 PDF 的 OCR、需要登录的视频、音频转写不作为已经具备的能力。原生文件发送失败保留 `.failed`，结果不明确时不会盲目重发；检查 QQ 网关日志与 file-deliveries 后再人工恢复。

DeepSeek Search / Fetch 使用同一服务端 API Key，通过官方工具端点调用；按 API 账户计费。聊天工具循环最多 3 轮、每轮最多 3 个有效工具调用；所有 tool_call_id 都回填结果，保留模型必要的 reasoning_content，但不公开内部思考。后台 max 可生成有依据的建议和明确交办的资料任务；未经直接交办不把引用、转发当开发授权。

## 夜间做梦

参考 WhalePartner 的来源与日记边界，以及 [OpenClaw Dreaming](https://docs.openclaw.ai/concepts/dreaming) 的离线整理思路。原文落库不调用模型；白天 high 只处理聊天和明确任务。悉尼时间 03:00–06:00 且安静 20 分钟后，每次整理最多 60 条、每晚最多 8 批。先筛直接来源、排除凭据和转发指令，再用 max 提取长期事实、合并纠错并反思。事实保留原文与历史版本，dreams 只供人查看，不回灌成群友事实、不发群消息。重要方案通过独立任务队列调用 max；普通 CSV 等小活使用 high。

## 群聊表达机制

重点参考 [MaiBot](https://github.com/Mai-with-u/MaiBot) 的群聊调度、表达选择和黑话学习设计，未复制其 GPL 源码。参考的模块包括 `src/maisaka/scenes/group/scheduling.py`、`src/chat/replyer/maisaka_expression_selector.py`、`src/learners/jargon_learner.py`，以及 [AstrBot 自然聊天 skill](https://github.com/1rua/astrbot-qq-natural-chat-skill/blob/main/SKILL.md) 的语境、短句与 emoji 原则。

- `semantic.ts` 负责语义、工具与有来源的结果；`voice.ts` 负责最终群聊表达。high 先判定是否需要参与；沉默只做判定，选中回复后交给独立、没有工具的 high 嘴替。工具任务把已核实结果交给嘴替。后台 max 方案只上看板，群里由 high 说要点。
- `learning.ts` 在夜间按真实消息、不同发言者统计重复短语，再由 max 核对含义、情境与原文。高频只是候选，至少 3 条、2 人或明确解释才可启用。只检索当前语境相关的最多 3 条表达，45 天未更新的不主动注入；成员可停用，夜间学习不覆盖停用决定。
- 只有 `banter` 模式且不含技术保护内容时，按事件 ID 稳定地低概率省略句号、生成一个常见同音字错误，或拆成 2–3 条消息；正式工作和关怀场景不做这些变化。不会随机破坏数字、链接或文件名。分片持久保存，重试不会再次随机变化；QQ msg_seq 按稳定 ID 生成。
- 小文件 high 与耗时资料/视频分开领取，聊天、仓库心跳与仓库同步分别运行，互不排队等待。重要资料任务才使用 max。

本轮验证：18 项 Worker/表达集成检查、6 项执行端检查；实际 QQ 非 @ 对话、网页检索、项目方案落库、群成员登录、CI 失败通知和 CSV 原生附件交付已观察。CSV 的 UTF-8 中文与 3 行数据逐项核对。夜间计划仍待第一次真实夜间运行，真实代码任务的草稿 PR 与 24 小时连续运行仍待验收。

运行修复：聊天突发消息合并，避免延迟逐条补答；引用旧回复不自动重新处理其链接。资料超时终止整个子进程组，失败只通知一次，原始命令和本机路径仅保留在本地诊断。资料任务结果和接力入口展示在看板。

群聊参与判定借鉴 MaiBot 的调度与强制触发分离：旁听优先，明确交办/提及/引用续问可回应，主动插话按信息价值、对话位置和气氛判断，合适时可继续接梗，不设固定次数或时间配额。对话按发言者和时间合并，标出机器人自己的发言与原回复，避免把群友对其他人的“你”认成自己。

人格连续性：稳定的团队搭子身份与口吻由系统维护，夜间 max 从真实聊天更新第一人称 self_note，记录兴趣、反思和未完事项。近况作为有来源的连续性资料注入嘴替，不成为新的用户事实或执行权限；平时不反复自我解释模型身份，被明确问及真实身份时如实回答。
