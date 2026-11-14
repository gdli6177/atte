# 从 Crewvane 升级到 Atte

本文说明当前代码在旧版升级时的实际行为。GitHub 仓库重命名由维护者操作；代码中的
下载、发布和仓库引用已经改为 `github.com/gdli6177/atte`。

## 标识变化

| 项目 | 旧标识 | 当前标识 |
| --- | --- | --- |
| npm workspace 包 | `@crewvane/*` | `@atte/*` |
| CLI | `crewvane` | `atte`，没有 `crewvane` 命令别名 |
| 用户安装目录 | `~/.crewvane` | `~/.atte` |
| 工作区状态与锁 | `.crewvane` / `.crewvane-lock` | `.atte` / `.atte-lock` |
| macOS 应用数据 | `appData/Crewvane` | `appData/Atte` |
| 新写入环境变量 | `CREWVANE_*` | `ATTE_*` |
| IPC 与插件 | `crewvane:*` / `dev.crewvane` | `atte:*` / `dev.atte` |
| Bot envelope | `crewvane.bot.v1` | `atte.bot.v1` |
| 新能力包清单 | `minimumCrewvane` | `minimumAtte` |

所有环境变量优先读取 `ATTE_*`，只有未设置新名时才回退读取 `CREWVANE_*`。为让旧版
Agent、Hook 和启动器继续收到同一份会话身份，Atte 启动的子 Agent 或生成的 launcher
仍会镜像一部分旧变量名；这是过渡期的兼容输出，不是新的配置入口，也不复制模型密钥
或登录凭据。新客户端读取 `ATTE_*` 优先、旧名回退，旧客户端继续只读旧名；两者共享
同一份已迁移状态，不会同时创建两份业务状态。

安装包、应用与 CLI 文件名都使用 Atte。由旧应用创建的 MCP / Hook 配置仍然读取
`CREWVANE_*` 和 `crewvane.bot.v1`，新的配置写入 `ATTE_*` / `atte.bot.v1`；
但 `crewvane` 不再是可执行命令，旧外部配置若直接调用它，需要改用 `atte` 或在
设置中重新安装 CLI、Hooks 和 Skills。应用不会改写不受它管理的 MCP 配置。

## 一次性迁移

工作区第一次被新 Core 打开时，若只有 `.crewvane`，会在同一工作区锁内复制到临时
目录，递归核对普通文件清单与每个文件的 SHA-256，然后写入 `.atte-migration.json`
并原子改名成 `.atte`。快照中的附件路径和 Bot 协议会更新；事件日志保留原字节。
旧 `.crewvane` 完整保留，绝不自动删除。迁移拒绝跟随符号链接，也不复制特殊文件。

迁移失败时删除未完成的临时副本，继续使用旧 `.crewvane`，不会只留下错误页面。
此时旧附件路径也保持可用。下次启动会在新目录仍不存在时重试；用户可以根据诊断
修复源目录后重试。工作区锁兼容旧名称，但不会删除其他进程正在持有的锁。
普通目录锁只写 `.atte-lock`；只有工作区迁移/状态存储这一条兼容路径，在旧锁仍
存在或只有 `.crewvane` 状态目录时才同时取得 `.crewvane-lock`，避免 Agent 配置
目录、序列目录等普通锁继续产生旧名。

`~/.crewvane` 与 `appData/Crewvane` 同样采用复制、校验、写标记、保留旧目录的
策略。应用数据迁移在 Electron 读取工作区、Hook、Webhook 或 Session 配置之前完成；
失败继续使用旧目录。独立 `install.sh` 也执行同样的目录复制校验，失败时使用旧
安装目录继续升级，不将未完成的目录标为当前版本。

旧主题的 `crewvane.theme` 与侧栏键会读取一次并写回 `atte.*`。旧的受管 Skill、
Hook 所有权标记和 `minimumCrewvane` 清单仍受支持；旧 `crewvane` shim 只有确认
属于旧 Atte/Crewvane 安装器后才会移除，任意同名用户文件不会被删除。
旧 Herdr 插件记录 `dev.crewvane` 不再被新版使用，也不再写入事件；新版只注册
`dev.atte`。如果 Herdr 中仍显示旧插件条目，可以手动移除，不影响目标与工作区数据。

## 回滚

1. 关闭 Atte 与所有正在写工作区的 Agent / CLI，避免旧版和新版本同时写入。
2. 保留两个目录作为备份；若要回到旧版本，将当前 `.atte` 改名保存，例如
   `.atte.after-upgrade`，再把原 `.crewvane` 保持或恢复为该名称。不要删除旧目录。
3. macOS 应用数据同理：退出应用后保存 `appData/Atte`，让旧版继续读取原
   `appData/Crewvane`。独立安装目录保存 `~/.atte`，旧 `~/.crewvane` 仍在。
4. 用旧版安装包重新安装旧 CLI 与 Skills。当前 Atte 不提供 `crewvane` 别名，
   不能靠继续调用旧命令完成回滚。
5. 若已安装新的独立 CLI shim，回滚旧安装器前先移除 `~/.local/bin/atte`；旧版
   `~/.local/bin/crewvane` 只应由旧安装器重新创建。

回滚针对的是文件目录；在 Atte 中已经新增或更新的业务状态，旧版本不一定支持。
因此迁移期间产生的 `.atte` 必须保留供恢复与排查，不能用旧目录覆盖后声称新
写入也已回滚。若迁移失败后一直使用旧目录，则无需执行目录回滚。

## 验证

`packages/core/test/state-migration.test.ts` 覆盖复制校验、旧目录保留、事件原字节、
旧附件、旧清单/协议字段与失败回退；`compatibility.test.ts` 覆盖新环境变量优先和
嵌套字段改写；`storage-lock.test.ts` 覆盖新旧锁所有权、普通锁不写旧名及跨工作区
重入。Bot、Hook 和旧能力包清单各有真实调用回归；`legacy-cli.test.ts` 验证只删除
受管旧 shim；Skill 安装器测试验证只迁移受管旧 Skill。升级报告记录本轮实际验证及
受限项目，不以静态检查代替安装验收。
