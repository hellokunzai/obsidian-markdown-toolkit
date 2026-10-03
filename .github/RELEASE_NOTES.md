# Markdown Toolkit v0.18.1

在 Obsidian 里把图表、思维导图、流程图等 **12 种图形**可视化编辑，再一键写回纯文本；另附一套编辑器工具栏、文件浏览器增强与附件管理工具。所有图形都以**围栏代码块**存储 —— Markdown 本身就是数据，可纳入版本控制、跨平台迁移，也能被任何 Markdown 工具读取。

## 本次更新：低版本 Obsidian 兼容性修复

无功能变化，只修两处会在旧版 Obsidian 上**直接报错崩溃**的 API 误用：

- **`Vault.getFolderByPath()`** 需要 Obsidian 1.5.7+。已换成等价的 `getAbstractFileByPath()` + `instanceof TFolder` 写法，并把这份兼容封装收在 `attachment-paths.ts` 的 `folderAt()` 里，供附件整理与附件跟随改名共用。在 1.4.16–1.5.7 之间，「整理空附件目录」「附件跟随笔记改名」原本会抛 `not a function`。
- **`Item.setCssProps()`** 需要 Obsidian 1.13+。已移除，「隐藏规则」功能改由样式类 `.mtk-explorer-hidden` 完成 —— 那是 `display: none !important`，本来就已经比行内样式更强，这两行本就是冗余。

顺带清掉的杂项：

- 修正一处静态样式赋值（`color-picker` 面板的定位改为 `.mtk-color-panel.is-fixed` 类），不再直接写 `element.style`。
- 删除 6 个已无人引用的界面文案键（`editor.hint.dblclick` / `editor.hint.dragNode` / `editor.menu.shape` / `embed.unparsedLines` / `notice.inserted` / `notice.parseFailed`，中英各一份）。
- 新增 GitHub Actions 自动发布：打上 `v*` tag 即自动构建、校验产物与版本号，再把 `main.js`、`manifest.json`、`styles.css` 等文件挂到 Release 上。

## 安装

在 Obsidian 中打开 **设置 → 第三方插件 → 关闭安全模式**，浏览并搜索 **Markdown Toolkit** 即可安装；也可以从本页直接下载 `main.js` / `manifest.json` / `styles.css` 三个文件，放进 vault 的 `.obsidian/plugins/markdown-toolkit/` 目录后重启 Obsidian。

## 环境要求

- 最低支持 Obsidian **1.4.16**
- 桌面端与移动端均可使用
- 不发起任何网络请求、不需要账号、无内购
