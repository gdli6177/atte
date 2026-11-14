# Atte Logo 备选

状态：**历史评审材料。最终已选定 Six Vectors，本目录不再代表当前品牌。**
当前标识见 [Six Vectors 品牌使用规范](../../brand/six-vectors.md)。
每个方案提供透明背景的 1024×1024 SVG 与 PNG、深色和浅色背景预览；图标均保留
四周安全区。第一个方案使用现有像素吉祥物，后两个方向不改变当前运行时资产。

| 方案 | 方向 | 一句话说明 | 文件 |
| --- | --- | --- | --- |
| 01 | 现有像素吉祥物升级 | 深靛圆角底上放大的原有像素吉祥物，保留完整角色识别。 | [SVG](01-pixel-mascot.svg) · [PNG](01-pixel-mascot.png) · [深色](01-pixel-mascot.preview-dark.png) · [浅色](01-pixel-mascot.preview-light.png) |
| 02 | 全新极简图形 | 两束注意力线汇聚成 A，中心光点表示需要人处理的那件事。 | [SVG](02-attention-a.svg) · [PNG](02-attention-a.png) · [深色](02-attention-a.preview-dark.png) · [浅色](02-attention-a.preview-light.png) |
| 03 | 吉祥物 + 字标 | 缩小吉祥物并列 Atte 字标，兼顾角色记忆与产品名识别。 | [SVG](03-mascot-wordmark.svg) · [PNG](03-mascot-wordmark.png) · [深色](03-mascot-wordmark.preview-dark.png) · [浅色](03-mascot-wordmark.preview-light.png) |

## 比较

- **01 像素吉祥物**：延续现有资产，迁移风险最低；在 32px 下细节较多，适合桌面应用
  图标，不一定是单色菜单栏图标的最佳选择。
- **02 极简 A**：缩放最稳，深浅背景与单色化最容易；品牌角色感弱于吉祥物，需要
  后续再建立拟人化资产。
- **03 吉祥物 + 字标**：产品名识别直接，适合 README、启动页和宣传物料；方形图标
  内元素较多，超小尺寸需另做只保留吉祥物的响应式版本。

预览使用同一 1024×768 画布、同一图形尺寸和系统字体，只改变背景色，便于只比较
图形本身。可运行 `node docs/design/generate-design-options.mjs` 重新生成。
