# B站多P课程进度助手

适用于 [哔哩哔哩](https://www.bilibili.com) 多P视频课程页面的 Tampermonkey 用户脚本，帮助追踪分P学习进度。

## 功能

- **分P列表**：通过 B 站官方 API 获取当前视频的全部分P信息（序号、标题、时长）
- **进度状态**：每个分P标记为「未看」「进行中」或「已完成」，数据保存在浏览器本地
- **自动追踪**：播放当前分P时自动标记为进行中；播放到 90% 以上或播放结束时自动标记为已完成
- **进度摘要**：显示总分P数、已完成数量、预计剩余观看时长
- **一键续看**：跳转到第一个未完成的分P
- **手动切换**：点击每行状态按钮可循环切换完成状态
- **单P视频**：仅 1 个分P时面板显示简要提示，不干扰观看

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（篡改猴）或兼容的脚本管理器
2. 从 [Greasy Fork](https://greasyfork.org/) 安装，或安装开发版：

   ```
   https://github.com/Wan-JD/bilibili-multip-progress/raw/main/bilibili-multip-progress.user.js
   ```

3. 打开任意多P视频页面，点击页面右侧 **P** 按钮打开进度面板

## 使用说明

| 场景 | 操作 |
|------|------|
| 查看全部进度 | 点击 **P** 按钮展开面板 |
| 跳到未看完的分P | 点击「从第一个未完成的P继续」 |
| 手动标记某P已看完 | 点击该行右侧状态按钮循环切换 |
| 跳转到指定分P | 点击分P标题 |

进度数据存储在 `localStorage`，键名以视频 BV 号区分，清除浏览器数据会丢失记录。

## 隐私说明

- 脚本仅请求 B 站公开的视频信息 API（`api.bilibili.com`），使用你已登录的 Cookie 鉴权
- 不向任何第三方服务器发送数据
- 进度记录仅保存在本机浏览器

## 许可证

[MIT](LICENSE)

## 支持作者

如果这个脚本对你有帮助，可以在 [爱发电](https://ifdian.net/a/jd0512) 支持一下作者。

## 反馈

请在 [Issues](https://github.com/Wan-JD/bilibili-multip-progress/issues) 提交问题或建议。
