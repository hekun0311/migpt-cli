# 新版火山 TTS 接入

本 fork 将面板的火山 TTS 改为 V3 HTTP 单向流式接口。火山配置使用新版 API Key，不再支持旧版 APP ID / Access Token。Edge、OpenAI 和自定义 TTS 保持原有入口。

## 配置

1. 新版豆包语音控制台切换到复刻音色所属的项目，在 API Key 页面创建或获取该项目的 Key。
2. 面板 TTS 引擎选择“火山（豆包）”，填写 API Key。
3. 自定义复刻音色选“声音复刻 2.0”；系统音色选“语音合成 2.0”。
4. 复刻音色可选标准版或表现力增强版，实际效果以试听为准。
5. “音色”填写音色库中的完整 ID，不填写中文名称。API Key、服务开通和音色应属于同一项目。
6. 保留原来的对外地址，点击“测试语音配置”。失败会显示上游错误信息和可用的 Log ID。

旧配置导入后，需重新填写以上火山字段。不要把 APP ID 或 Access Token 当作 API Key。

Play 增强版硬件 `L05C` 的网络音频使用 `player_play_music` 协议，按 MiService 的已公开请求结构下发；其他机型和原生朗读沿用现有方法。日志中的接口接受状态不等于音箱已发声，仍需结合 `TTS播放` 请求和设备试听确认。

## 本地构建与启动

使用 Node.js 22 和 npm，在仓库根目录执行：

```sh
npm ci
npm run build:volcano
npm run test:volcano
node apps/server/dist/index.js --port 36592 --user YOUR_USER --pwd YOUR_PASSWORD
```

现有配置存储位置仍为运行用户的 `~/.migptgui`。不要在已有部署上同时启动两个实例。

## Docker / 1Panel

已有运行中的 `migpt-volcano-v3` 容器时，推荐按 [统一更新菜单接入说明](deploy/1panel/README.md) 做一次迁移。之后执行 `yklx-update` 选择 MiGPT 即可自动构建更新，不必每次手动替换容器。

原仓库 `docker/Dockerfile` 会安装 npm 上的旧版，不包含本次修改。请在仓库根目录构建新的 Dockerfile：

```sh
git clone https://github.com/hekun0311/migpt-cli.git
cd migpt-cli
docker build -f Dockerfile.volcano-v3 -t migpt-volcano-v3:local .
```

在 1Panel 中创建测试容器，镜像选 `migpt-volcano-v3:local`。配置目录挂载到 `/root/.migptgui`，先使用原配置目录的备份副本；容器端口为 `36592`，测试时映射到不同的主机端口。按原部署方式设置 `--user` 和 `--pwd` 参数，并将面板对外地址改为测试容器实际可访问的地址。

确认测试音频和小爱播放正常后，再切换正式容器。不要删除原容器或原配置作为升级步骤。

## 验证范围

### L05C 接管提速与触发前缀

L05C 在自定义 TTS、`streamResponse: false` 下，命中 AI 对话后并行执行暂停、原有静音设备指令和模型请求；接管完成后才允许正式音频下发。同轮不重复接管，也不播放“AI 思考中”提示，面板保存的提示配置保持原样。新问题或停止服务会使旧轮失效；已经发出的控制调用结束前，不下发新的回答音频。接管失败不重试、不切回原生回答。

面板“AI 对话触发前缀”不修改设备的硬件唤醒词。例如设置“派蒙同学”后，先说“小爱同学”，再说“派蒙同学，今天星期几？”。匹配仍要求问题以配置的前缀开头；连续对话区域的进入、退出关键词也只控制 MiGPT 会话。

更新继续使用 `yklx-update` 选择 `3`，完成后在面板启动。日志 `对话接管` 使用 `turnId` 关联消息匹配、暂停与静音调用、模型请求与回答完成、接管完成和正式音频下发；耗时从该轮匹配开始计算，不记录提问正文、前缀值或完整音频地址。“模型接口返回”可能只表示已拿到流句柄，“模型回答完成”才表示生成结束。

设备验收请对相同问题测试至少 5 轮，记录小爱是否开口、停止时机和派蒙开始时机，并保存更新前后日志。模拟测试不能代替设备听感，也不保证小米云端对话记录出现前完全不抢答。部署健康检查不自动发起小米登录或收费模型、语音调用；如需撤销行为，通过回退提交再更新，不覆盖配置或数据库。

已完成 TypeScript 编译、前端生产构建和模拟 V3 音频流测试。模拟测试包含分片、元数据、标准/增强模型参数、HTTP/业务错误、空音频和流中断；不调用真实火山账号。

真实账号鉴权、音色权限、计费、Docker 镜像构建和小爱设备播放仍需部署验证。本地 Docker 引擎未运行，未声称镜像构建成功。

官方接口说明：https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh
