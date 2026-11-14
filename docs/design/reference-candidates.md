# awesome-design-md 参考候选

调研日期：2026-11-14。需求来源：
[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)。
核对该仓库 `main` 的 `fcc70284932276d085f01ef9f83edde90b1258cb`，并阅读以下
实际 `DESIGN.md`，不是只按站点名称或目录摘要推断。

| 候选 | 已核实的特点 | 与 Atte 的适配点 | 不宜直接复制的部分 |
| --- | --- | --- | --- |
| [Linear](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/linear.app/DESIGN.md) | 近黑画布、细分层表面、单一强调色；4/8/12/16/24/32/48px 间距；标题到 12px caption 的字阶；按钮、输入框和卡片均引用 token。 | 工程工具的克制层级、平面卡片、语义色职责、间距与组件 token 的组织方式。 | 紫蓝强调色、专用字体、营销页的大标题与截图展台；这些不等于 Atte 的品牌决定。 |
| [Raycast](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/raycast/DESIGN.md) | 近黑画布、命令面板式紧凑行、6–10px 圆角与发丝边界；白色主按钮，彩色只用于分类提示。 | 高频操作、键盘优先、紧凑目标行和明确的单一主动作。 | 红色渐变 hero、Inter `ss03` 特征与营销页大截图；不复制品牌装饰和字体特性。 |
| [Vercel](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/vercel/DESIGN.md) | 近白画布、黑白高对比、胶囊按钮、技术标签与少量多色渐变强调；几何无衬线标题。 | 极简层级、清楚的主次动作和适合工程用户的克制表面。 | Geist / Geist Mono、品牌渐变与营销页 192px 段落节奏；只保留通用的黑白层级方法。 |

## 当前落地与边界

根目录 [DESIGN.md](../../DESIGN.md) 已按本仓库现有实现记录色板、字阶、间距、
圆角、阴影、动效、组件和响应式规则，并链接到实际 token。没有整份复制候选文件，
也没有把任何候选的颜色、字体或品牌元素静默定为 Atte 规范。

现有简约实现可对照候选中的共性：单一主动作、平面边界、4pt 间距、明确字阶、
组件引用 token；三份同页对比稿见 [首页设计基线](baseline-compare/README.md)。
这是与已落实设计的核对，不代表已经选定其中一个参考站点。

TODO(atte-decision: design-reference)：最终选择哪个参考站点待确认，状态汇总在
[仍开放的设计评审](../product/atte-iteration.md#仍开放的设计评审)。确认后需要把选择
及取舍写入 `DESIGN.md`；若与当前 token 冲突，应另行提交视觉调整并重新走查。
因此 VI-3 的仓库文档与候选调研已完成，最终参考站点选定仍待批准。
