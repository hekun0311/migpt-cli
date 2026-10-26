# 加入现有 yklx-update 菜单

本目录为已部署的 `migpt-volcano-v3` 容器提供一次性 Compose 迁移及后续更新。不替换 `yklx-update` 命令，不修改 MinIO / Workbench 的注册项。

## 首次安装

在 **Linux 服务器终端**中以 root 执行一次：

```sh
cd /opt/migpt-volcano-v3/source
git pull --ff-only origin main
sh deploy/1panel/install.sh
```

前提：当前分支为 `main`、工作区干净，旧 `migpt-volcano-v3` 容器正在运行，并且 `/root/.migptgui` 已持久挂载。服务器需有 Python 3.9+、Git、Docker 和 Docker Compose 2.20+；原有 `/usr/local/bin/yklx-update` 和 `/etc/yklx-update/projects.conf` 必须存在。不在安装脚本中安装或升级这些系统依赖。

安装器将：

1. 读取实际容器配置，检查能否准确迁移；安全路径列表与服务器 Docker 自身默认值核对（临时创建探测容器，不启动、不挂载旧数据，读取后删除）；不支持的非默认配置会报错停止。
2. 使用当前源码构建镜像，此时旧服务仍运行。
3. 停止旧容器并备份 `/root/.migptgui` 和 `/app/node_modules/mi-gpt/prisma`；数据库完整性及机器人索引校验通过后，首次迁移时将数据库保存到独立持久目录并挂载，保留原挂载、端口、环境变量、启动参数、网络和登录设置。
4. 将旧容器改名保留并关闭其自动重启策略，避免服务器重启后争抢端口；以 Compose 服务 `migpt` 启动新容器。
5. 检查面板 `/ping` 端点；成功后按项目 ID 注册 MiGPT。重复安装不会重复注册或创建容器。

服务器专用部署配置保存在 `/opt/migpt-volcano-v3/runtime/compose.json`，凭证只保存在服务器，文件权限为 `600`、目录为 `700`；不要上传或公开此文件。主 Compose 文件使用 `include` 引用它，统一菜单无需读取额外环境文件即可显示状态。

机器人数据库必须与 `.bot.json` 一起保留。数据库所在的 Prisma 目录单独持久挂载到 `/app/node_modules/mi-gpt/prisma`，首次持久化目录位于 `/opt/migpt-volcano-v3/databases/时间-版本/`。目前本项目固定沿用 mi-gpt 4.2 的数据库格式；升级 mi-gpt 依赖及数据库结构不属于此更新工具的职责。

## 已迁移后出现 find bot failed 的恢复

如果之前只挂载了 `/root/.migptgui`，重建后旧 `.bot.json` 可能指向已丢失的数据库。不要删除索引或重置。先通过 `docker ps -a --filter name=migpt-volcano-v3` 找到保留且停止的旧容器，拉取修复后执行：

```sh
python3 deploy/1panel/deploy.py recover-db /opt/migpt-volcano-v3/source main 旧容器完整名称
```

恢复过程不构建镜像：先停止当前容器，备份当前配置和数据库，再从明确指定的旧容器复制 Prisma 目录。它只在副本上恢复 SQLite 日志并检查完整性及机器人/主人 ID，校验通过后才挂载新的持久目录。不会删除 `.bot.json`，不会覆盖已有数据库目录。原数据库及日志文件仍保留在备份和旧容器中。若新容器健康检查失败，回到恢复前的部署配置。

## 日常更新

```sh
yklx-update
```

选择 `3. MiGPT`（前两个项目仍为 MinIO-YKLX、YKLX Workbench 时）。如果已有其他项目，按菜单显示的 MiGPT 编号选择。

更新脚本只快进拉取 `main`，构建后切换本项目容器，并等待面板健康检查。不会清理旧镜像、其他项目的容器或备份；不会自动调用小米登录、语音合成及收费接口。更新后请在 MiGPT 面板点击“启动”，再验证音箱和派蒙音色。

## 失败与回退

- 构建失败：尚未停止旧容器。
- 停机后的配置备份失败：恢复运行旧容器，不替换。
- 新容器启动或健康检查失败：首次迁移恢复保留的旧容器；后续更新使用旧镜像的不可变 ID 恢复 Compose 服务。
- 每次部署的容器配置、菜单注册表和停机后的数据备份保存在 `/opt/migpt-volcano-v3/backups/时间-版本/`，仅管理员可读。
- 自动回退只恢复镜像和部署配置，不自动覆盖应用数据。若回退本身失败，会明确报告备份位置；不要删除旧容器或备份。
- 手动强制结束更新进程或服务器断电不能保证自动回退完成；应检查容器和最近备份后再操作。

只输出版本、服务名及经过筛选的末尾诊断日志；不打印 `docker inspect`、环境变量、启动密码、完整音频地址或原始调试日志。

## 本地验证

```sh
python3 deploy/1panel/test_deploy.py
sh -n deploy/1panel/install.sh deploy/1panel/update.sh
```

模拟测试覆盖迁移参数保留、Compose 转义、注册幂等、构建失败、备份失败、健康检查失败及回退。真实镜像构建、容器迁移和音箱播放需在服务器验证；本机未启动 Docker 引擎，未声称已经完成服务器迁移。
