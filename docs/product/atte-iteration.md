# Atte 迭代与验收

> **历史记录（0.12 前后）**：本文包含 Orca、自主验收、本地能力包、Bot 和旧设置
> 分组等已退役内容，只用于追溯当时实现。0.14 当前行为以[使用说明](../atte.md)
> 和[架构](../ARCHITECTURE.md)为准。

需求日期：2026-11-13（北京时间）。开发日期：2026-11-14。
本轮展示名按需求使用 Atte，定位为「注意力中心 · The attention layer」。
第二轮内部标识、目录迁移与首页尺寸的拍板见[升级说明](../upgrade-atte.md)；
下文保留第一轮的决策过程，不再代表当前内部标识的兼容边界。

## 第一轮兼容边界（已被第二轮拍板取代）

以下只是第一轮当时的实现记录，均已被第二轮取代，不是当前行为：当时没有改仓库、
npm 包、CLI、目录、环境变量、IPC、Bot 协议或插件 ID；应用数据仍读取
`appData/Crewvane`，主题键仍是 `crewvane.*`，已安装 Hook 标记也保持旧写法。
第二轮已改为 `@atte/*`、`atte`、`.atte`、`ATTE_*`、`atte:*`、`dev.atte` 与
`atte.bot.v1`。旧目录、旧键和旧所有权标记只在一次性迁移或读取兼容路径保留。

第二轮已批准全部内部标识改名，并实际提供一次性复制校验迁移；不再保留旧 CLI
命令别名。已拍板事项见下表，仍开放的设计项另见
[Logo 备选](../design/logo-options/README.md)与[基线对比](../design/baseline-compare/README.md)。

## 验收范围

按 P0（BR-1、BR-2、IX-1）、P1（BR-3、BR-4、VI-1、VI-2、IX-2）、
P2（BR-5、VI-3、VI-4）推进。没有源码的独立官网或商店条目不视为已发布，
仅在仓库准备对应文案。实际结果和最终阻塞见[验收记录](../qa/atte-iteration.md)。

## 已关闭决策（历史）

| 标记 | 本轮边界 |
| --- | --- |
| public-spelling-and-identifiers | 已拍板：对外 `Atte`，内部全部改为 `atte`，不保留 CLI 别名。 |
| acceptance-primary-action | 已拍板：验收保留独立主按钮，其余反馈合并为一个消息入口。 |
| home-mark-size | 已拍板：本轮维持 96px 和原响应式显示规则，最终尺寸待设计评审。 |
| settings-scope | 已拍板：只重排，不删除、不合并任何设置功能，统一显式保存行为。 |
| positioning-publication | 已拍板：「注意力中心 · The attention layer」，不发布外部内容。 |
| origin-publication | 已拍板：名字由来只在内部 docs 记录，不进入关于页、README 或对外物料。 |
| logo-and-brand-color | 已拍板：品牌标识为 Six Vectors，使用墨 `#171A1E`、暖白 `#F3F1EA`、琥珀 `#F5A524`、图标底 `#14181B`；原像素吉祥物保留为角色插画。 |

## 仍开放的设计评审

| 标记 | 当前状态 |
| --- | --- |
| TODO(atte-decision: design-reference) | awesome-design-md 的 Linear、Raycast、Vercel 三份同页比较稿已备好；最终参考站点未选定，见 [基线对比](../design/baseline-compare/README.md)。 |

## Skill 文案 eval

| 输入场景 | 预期 |
| --- | --- |
| 用户请求安装主协议或本地方法 | 展示产品名 Atte，实际安装 `atte`、`atte-local-pack-author`，不创造旧命令别名。 |
| Agent 遇到已有 CLI / OMP 扩展 | 保留旧所有权标记，只合并受管条目，不覆盖第三方 Hook。 |
| 用户询问 CLI 用法 | 帮助标题为 Atte，示例调用 `atte`，新协议字段使用 Atte 名称。 |
| 历史 ship-* 技能被触发 | 说明中的产品展示名为 Atte；示例调用 `atte`，旧协议仅在兼容路径读取。 |

## 验收消息入口（IX-1）

桌面轻量验收卡、完整详情与终端注意力控制台统一提供「给管家发消息」和独立的
「验收通过」。消息允许追加要求、提问与附图，通过 `goal.message` 保存原话并派发给
管家；发送本身保留 `review`、原交付、验收注意力，不提交 `goal.rework`。
管家核对后才能通过独立状态命令安排修改。空消息不可发，失败保留草稿并显示错误，
取消返回原验收动作；人工验收按钮仍走带 attention 身份的 `goal.accept`。
独立复核进行中的自动验收目标继续遵守原授权门禁。

CLI 的 `goal rework` 是保留的显式状态协议，不是交互按钮或命令别名。
终端控制台移除直接返工快捷键，`c` 发送反馈，`a` 明确验收。

## 图标准备（BR-4）

界面使用 `BrandMark`，应用、Dock、菜单栏、favicon 与打包器均切换到
Six Vectors 的 `atte-*` 挂点。提供 1024、512、256、128、64、32px 应用图标 PNG、
16–1024px ICNS、16/32px favicon 与深浅托盘图标；来源及 SHA-256 记录在
`apps/desktop/assets/brand/atte-assets.json`。

品牌标识与角色插画分工见[品牌总览](../brand/README.md)。原像素吉祥物完整保留，
只用于首页、首启和管家卡片，不进入应用图标或菜单栏。

## 简约界面与 token（VI-1、VI-2）

首页去除轨道与光点，详情去除网格与光晕，侧栏和顶栏使用纯色，
普通卡片取消装饰阴影与悬停抬升。正文调整为 14px，元信息最低 12px；
深浅主题继续使用已有语义色。首页、详情、设置共用同一套原语和 token。

`tokens.css` 提供 primitive / semantic / component 三层与六类 token；
原有布局尺寸集中管理，媒体查询保留必要断点。终端颜色、字体、字号从 token
读取，减弱动态效果时关闭光标闪烁。实现规范见 `DESIGN.md` 与
[token 文档](../design/tokens.md)，Skill 与 eval 同步更新。

## 设置重排（IX-2）

设置按“工作区与外观 / 执行现场 / Agent 与工作方法 / 授权与自主推进 / 通知”
分组，并增加页内分组导航。每项保留名称、当前值与明确操作。
字段编辑统一显式保存，外观与现场选择不再点选即写入；加载失败不可覆盖现场设置，
有未保存更改时必须先保存再测试。原有功能、实验授权、Hook 保护、安装和清理边界保留。
完整项表与保存行为见 [设置说明](../design/settings.md)。

## P2 文档范围（BR-5、VI-3）

命名灵感只写入[内部记录](../brand/naming-origin.md)，未经批准不在关于页或 README
公开。awesome-design-md 的 Linear、Raycast、Vercel 候选已按实际文件整理到
[参考候选](../design/reference-candidates.md)，三份同页静态稿见
[首页设计基线](../design/baseline-compare/README.md)。根目录 `DESIGN.md` 与当前
token、组件和响应式实现一致；最终参考站点仍待确认，不宣称已经完成品牌定稿。

## 首页图形预览（VI-4）

首页沿用原像素吉祥物和 96px 基线，保留原响应式隐藏规则；独立的
`--brand-home-preview-scale` token 保留为设计预览挂点，但不放大实际渲染。
本轮不替换新 logo，也不决定最终尺寸。
