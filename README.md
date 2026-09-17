# 必应壁纸新标签页

Chrome / Edge 扩展。把新标签页换成必应中国区当日壁纸，只有一个搜索框，右上角可选显示天气。

## 功能

- 每天自动换成必应当日壁纸，支持 4K / 1080P；4K 还没生成时自动退回 1080P
- 往前翻最近 7 天的壁纸，也可以锁定当前这张
- 压暗、模糊可调，图片说明可隐藏，一键下载原图
- 右上角天气（和风天气），悬停看湿度、风力、能见度，点击打开 MSN 天气；城市可搜索切换
- 打开快：
  - 壁纸信息先用缓存、后台再核对，不等接口
  - 图片本体存在 Cache API 里，第二次打开基本瞬开
  - 1080P 先垫底、4K 到了再替换
  - 后台 service worker 在浏览器启动时和每天 00:02 预取当天壁纸，跨天第一次打开也不用等

## 安装

1. 下载或 clone 本仓库
2. （可选，要天气的话）复制 `config.example.js` 为 `config.js`，填上和风天气的 API Host 和 Key
3. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择本仓库目录

> 扩展加载后别再挪目录位置，挪了要重新加载，设置会丢。

## 天气配置

在 [和风天气控制台](https://console.qweather.com/) 创建项目和凭据，拿到：

- **API Host**：项目的专属域名，形如 `abc123def4.re.qweatherapi.com`
- **API Key**

免费额度有限，扩展对天气做了 15 分钟缓存。

`config.js` 已加入 `.gitignore`，不会被提交。**不要把 Key 写进其他会提交的文件里。**

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 扩展清单（MV3） |
| `newtab.html` / `newtab.css` / `newtab.js` | 新标签页 |
| `shared.js` | 壁纸拉取和缓存，新标签页和后台共用 |
| `bg.js` | 后台 service worker：启动时和每天零点后预取壁纸 |
| `config.example.js` | 天气配置模板 |

## 数据来源

- 壁纸：必应 `HPImageArchive.aspx` 接口（`mkt=zh-CN`）
- 天气：[和风天气](https://www.qweather.com/)

壁纸图片版权归各自的摄影师及版权方所有。
