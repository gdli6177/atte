# Atte 品牌资产准备

本轮只建立现有像素吉祥物的导出链与替换挂点，没有定稿新 logo。
`baseline` 表示已有图形的过渡导出，不是已批准的新品牌方向。
最终图形与颜色见[仍开放的设计评审](../../../../../docs/product/atte-iteration.md#仍开放的设计评审)。

## 保留原图

- `crewvane-mage-source.png`：历史原稿，文件名保留以追溯来源。
- `crewvane-mage.png`：已有 512px 透明吉祥物。
- `crewvane-macos-source.png`：已有 macOS 图标原稿。
- `crewvane-icon.png`、`crewvane-icon.icns`、`crewvane-trayTemplate.png`：历史导出，保留供追溯。

原图不覆盖、不删除，不新增图形，不把已有设计的形状和配色当后续约束。

## 新挂点

- `atte-mascot-baseline-512.png`：原吉祥物的完整副本，用于首页、首启和侧栏。
- `atte-icon-baseline-{32,64,128,256,512,1024}.png`：从已有 macOS 原稿导出。
- `atte-icon-baseline.icns`：含 16–1024px 表示的应用图标包。
- `atte-assets.json`：记录 `baseline-preparation` 状态、来源、输出与 SHA-256。

`src/ui/BrandMark.tsx` 是界面替换入口，应用、Dock、菜单栏、打包器与 favicon
都读取对应新挂点。最终素材批准后替换来源再导出，无需逐页找图片。

在 macOS 上运行 `pnpm --dir apps/desktop exec node scripts/build-icons.mjs`。
构建也执行同一导出。所有文件明确命名，原图不会被写回。
深浅背景与缩小显示纳入桌面验收；最终图形的设计签字仍待董事长确认。
