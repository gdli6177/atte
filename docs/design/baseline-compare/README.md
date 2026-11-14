# 首页设计基线对比

状态：**Vercel 已选定**（2026-11-14）。
正式界面按 Vercel 的高对比、胶囊控件和平面留白基线实施，使用 Atte 品牌色。
三份静态稿继续保留为选择依据，使用完全相同的页面结构与内容，便于追溯取舍。

| 参考 | 静态稿 | 主要取舍 |
| --- | --- | --- |
| Linear | [linear.html](linear.html) | 信息密度高、工程工具气质强；深色长时间阅读好，但对非工程用户更冷。 |
| Raycast | [raycast.html](raycast.html) | 命令面板式紧凑行和白色主按钮操作感最强；密集深色界面需要更严格控制信息噪声。 |
| Vercel | [vercel.html](vercel.html) | 黑白对比和胶囊控件最轻、最清楚；技术感强，但柔和度和角色识别弱于前两者。 |

来源版本为 awesome-design-md `fcc70284932276d085f01ef9f83edde90b1258cb` 中
[Linear](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/linear.app/DESIGN.md)、
[Raycast](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/raycast/DESIGN.md) 和
[Vercel](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/vercel/DESIGN.md)
的实际文件；不是按品牌印象仿制。字体使用系统字体，未复制候选品牌字体、Logo、
配色或营销素材。

## 共同页面

- 左侧：工作区、注意力计数、项目与管家入口。
- 主区：一句当前结论、三条不同优先级的注意力卡、每卡一个主动作。
- 右侧：今日概览、最近完成与记录入口。

对比只覆盖首页静态外观；正式实现以根目录 `DESIGN.md` 和 `tokens.css` 为准。
本次选择不引入比较稿中的营销渐变、字体、Logo 或三列结构。
键盘、焦点、响应式、真实数据和 Electron 打包须独立验收，见
[改版验收记录](../screenshots/README.md)。
可运行 `node docs/design/generate-design-options.mjs` 重新生成 HTML 与 Logo PNG；
渲染依赖本机 Sharp，可用 `ATTE_SHARP_PATH` 指向已安装的 Sharp 入口。
