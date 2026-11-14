# Atte 迭代与验收

需求日期：2026-11-13（北京时间）。开发日期：2026-11-14。
本轮展示名按需求使用 Atte，定位为「注意力中心」。这是本轮实现用语，不替代最终品牌决策。

## 兼容边界

- 仓库地址、npm 包名 `crewvane` / `@crewvane/*`、CLI 可执行文件 `crewvane` 保留。
  未添加 `atte` 命令或任何旧命令别名。
- `.crewvane/`、`~/.crewvane`、`CREWVANE_*`、IPC / Bot 协议、插件 ID、
  Skill 名称、代码类型与测试临时目录是内部标识，保留以保障兼容。
- macOS 安装包、应用、菜单、窗口标题与对外文案使用 Atte。应用数据继续使用
  `appData/Crewvane`，在 Electron 初始化前固定该路径，防止改展示名后产生空白配置。
  `crewvane.theme`、`crewvane.sidebar-collapsed` 等持久键继续使用原值。
- 已安装 CLI 的 `# Crewvane embedded CLI` 和 OMP 扩展的
  `// Crewvane managed OMP extension` 是识别所有权的协议标记，不能随文案改名。
- 原始品牌图片保留在原路径，作为后续升级来源；历史发布记录保留原文。

后续如批准目录迁移，建议先提供一次性迁移：检测旧目录、锁定、备份、原子迁移、
校验后切换，失败回退；同一次启动不能同时创建两份状态。本轮不执行目录迁移。

## 验收范围

按 P0（BR-1、BR-2、IX-1）、P1（BR-3、BR-4、VI-1、VI-2、IX-2）、
P2（BR-5、VI-3、VI-4）推进。没有源码的独立官网或商店条目不视为已发布，
仅在仓库准备对应文案。验证记录在本文件收尾补齐。

## 待决策

| 标记 | 本轮边界 |
| --- | --- |
| TODO(atte-decision: public-spelling-and-identifiers) | 最终对外大小写及仓库、包、命令、目录是否改名待确认；本轮展示 Atte，内部标识保留。 |
| TODO(atte-decision: acceptance-primary-action) | 是否把验收通过也并入消息待确认；按本轮验收保留独立主按钮。 |
| TODO(atte-decision: logo-and-brand-color) | 最终 logo 方向及主色待确认；仅准备现有像素吉祥物的导出与替换挂点，不创作新图形或更换品牌色。 |
| TODO(atte-decision: home-mark-size) | 最终首页图形及尺寸待确认；通过独立 token 支持放大与调整，不把临时尺寸当定稿。 |
| TODO(atte-decision: settings-scope) | 合并或删除设置功能待确认；本轮仅重排已有功能和统一保存反馈。 |
| TODO(atte-decision: positioning-publication) | 英文、副标题及官网、商店发布范围待确认；本轮使用中文定位，不发布外部内容。 |
| TODO(atte-decision: origin-publication) | 名字由来是否公开待确认；只在内部说明记录。 |
| TODO(atte-decision: design-reference) | awesome-design-md 中最终参考站点待确认；不把参考候选当设计定稿。 |

## Skill 文案 eval

| 输入场景 | 预期 |
| --- | --- |
| 用户请求安装主协议或本地方法 | 展示产品名 Atte，实际安装 `crewvane`、`crewvane-local-pack-author`，不创造命令别名。 |
| Agent 遇到已有 CLI / OMP 扩展 | 保留旧所有权标记，只合并受管条目，不覆盖第三方 Hook。 |
| 用户询问 CLI 用法 | 帮助标题为 Atte，示例仍调用 `crewvane`，原协议字段不变。 |

## 验收消息入口（IX-1）

桌面轻量验收卡、完整详情与终端注意力控制台统一提供「给管家发消息」和独立的
「验收通过」。消息允许追加要求、提问与附图，通过 `goal.message` 保存原话并派发给
管家；发送本身保留 `review`、原交付、验收注意力，不提交 `goal.rework`。
管家核对后才能通过独立状态命令安排修改。空消息不可发，失败保留草稿并显示错误，
取消返回原验收动作；人工验收按钮仍走带 attention 身份的 `goal.accept`。
独立复核进行中的自动验收目标继续遵守原授权门禁。

CLI 的 `goal rework` 是保留的显式状态协议，不是交互按钮或命令别名。
终端控制台移除直接返工快捷键，`c` 发送反馈，`a` 明确验收。
