# Atte 品牌资产

定稿标识为 **Six Vectors / 六向**。完整规范见
[Six Vectors 品牌使用规范](../../../../docs/brand/six-vectors.md)。

## 分工

- **Six Vectors 是品牌标识**：用于应用图标、Dock、菜单栏托盘、favicon、侧栏、
  关于页、README 与字标。不要再把像素角色当作 Logo。
- **像素吉祥物是角色插画**：只用于首页、首启和管家卡片等应用内叙事场景。
  角色不是品牌标识，也不进入应用图标或菜单栏。

## 源文件

下列文件来自董事长定稿包，按原几何与配色保存；`atte-` 前缀遵循仓库现有命名：

- `atte-mark*.svg`：主标识、单色、反白和 16–32px 光学版。
- `atte-mark-{16,32}[-reversed]-source.png`：定稿包原生光栅化的光学版 PNG。
- `atte-app-icon.svg`、`atte-app-icon-source.png`：深墨圆角应用图标源文件。
- `atte-wordmark*.svg`：横向、竖向和反白锁定字标，字形已转路径。
- `atte-mascot-baseline-512.png`：原像素吉祥物完整副本，继续作为角色插画。
- `crewvane-*`：历史原稿与导出，保留用于追溯，不作为当前品牌挂点。

## 生成物

`scripts/build-icons.mjs` 是仓库现有图标生成入口，构建时自动执行：

- `atte-app-icon-{32,64,128,256,512,1024}.png`：从 1024 源图等比例导出。
- `atte-app-icon.icns`：含 16–1024px 表示的应用图标包。
- `atte-favicon-{16,32}.png`：定稿包的光学版，供浏览器 favicon。
- `atte-tray-{16,32}.png` 与 `atte-tray-reversed-{16,32}.png`：浅色和深色
  菜单栏使用的光学版，主进程随系统外观切换。
- `atte-assets.json`：记录 `final-six-vectors`、四个规范色、来源与每个输出的
  SHA-256。

重新生成：

```sh
pnpm --dir apps/desktop exec node scripts/build-icons.mjs
```

应用图标只使用 `#171A1E`（墨）、`#F3F1EA`（暖白）、`#F5A524`（琥珀）与
`#14181B`（图标底）。不要给标识增加渐变、阴影、描边或其他颜色。

`src/ui/BrandMark.tsx` 负责标识的深浅切换；`variant="mascot"` 只用于角色插画。
