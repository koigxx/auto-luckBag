# README 图片

这些 PNG 来自项目真实 Vue 界面的离线演示夹具，不是概念设计稿或线上运行记录。账号状态、房间、支出、结果及风险均为人工构造数据，不能作为收益或兼容性证明。

| 文档图片 | 离线输出 | 展示内容 |
| --- | --- | --- |
| dashboard.png | ui-overview-running.png | 当前任务、预约与预算 |
| settings.png | ui-settings.png | 参与偏好及禁用的实物选项 |
| rooms.png | ui-library.png | 历史房间与复访 |
| records.png | ui-records-review.png | 结果、账本入口及异常待办 |

更新方法：

1. 执行 `npm run test:smoke`，生成 `.test-output/ui-*.png`。脚本 `scripts/ui-smoke.cjs` 提供虚构 IPC 数据并拦截全部浏览器请求；Electron 冒烟使用隔离用户目录。
2. 截图前将页面滚动回顶部并等待布局稳定，避免全页截图中的固定导航错位。本次记录页通过忽略目录中的临时夹具副本补做此步骤，未修改产品代码。
3. 检查画面、示例数据和文字后，将上表的图片复制到本目录。不要使用真实登录态或真实账本截图替换。
4. 确认 README 图片链接可用，且功能文案与当前版本一致。

更新日期：2026-10-29。图片中的时间与数值来自演示夹具，不代表默认设置。
