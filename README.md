# 勇者逗恶龙

用自由输入和恶龙交涉，猜出它愿意放走公主的条件。每次送出理由，龙头上都会出现这一轮的匹配度。猜错时，恶龙先反驳一句，再给一句提示。线索会随回合逐渐具体，匹配度达到门槛就能救出公主。

## 在 Windows 上启动

需要 Node.js 22 或更新版本。在当前目录打开 PowerShell，运行以下命令，再打开 [本地试玩页](http://127.0.0.1:4173/)。

```powershell
node .\start.mjs
```

默认使用模型模式。模型配置缺失时，网页会显示场景和配置提示。将 `mode` 显式设为 `local` 可离线检查页面和交互。

## GitHub Pages 前端

在仓库的 **Settings → Pages** 将发布来源选为 **GitHub Actions**。Pages 工作流只发布 `public/` 目录。仓库变量 `GAME_API_BASE_URL` 留空时，网站展示游戏开场和前端预览提示。

部署在线 Node 服务后，将该变量设为游戏 API 的 HTTPS 基地址，例如 `https://game.example.com/api/`，再运行 Pages 工作流。在服务器的 `model.config.json` 中将 `frontendOrigin` 设为 Pages 的 HTTPS 来源，例如 `https://te-li.github.io`。该设置允许此网页调用 API，并关闭调试接口。将 Node 留在回环地址，由提供 HTTPS 的反向代理转发 `/api/`。模型密钥由在线服务保管。

当前 Ubuntu 部署使用 `dragon-quest` systemd 服务。登录服务器后，用 `sudoedit /opt/dragon-quest/app/model.config.json` 填写 `chat.apiKey` 和 `embedding.apiKey`，保存后运行 `sudo systemctl restart dragon-quest`。可用 `sudo journalctl -u dragon-quest -n 30 --no-pager` 查看服务日志。

Nginx 配置位于 `/etc/nginx/conf.d/dragon-quest.conf`。它提供 HTTPS，并给开局和猜测接口限流。IP 证书由 `dragon-quest-cert-renew.timer` 定期检查与续签。

## 使用自己的模型 API

直接编辑工作区中的 `model.config.json`。如果该文件不存在，运行 `Copy-Item .\model.config.example.json .\model.config.json` 创建它。

用 UTF-8 编辑 `model.config.json`，将 `mode` 改为 `api`，并填写下面两组配置。两组可以使用不同的服务商。

| 字段 | 填什么 |
| --- | --- |
| `chat.baseUrl` / `embedding.baseUrl` | 服务商的 OpenAI 兼容 API 根地址，保留服务商给出的 `/v1` 等路径 |
| `chat.apiKey` / `embedding.apiKey` | 对应服务商的 API Key |
| `chat.model` | 支持 `/chat/completions` 的文本对话模型名称 |
| `embedding.model` | 支持 `/embeddings` 的文本向量模型名称 |

例如百炼的向量模型可从其 [OpenAI 兼容 Embedding 文档](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai) 查询 API 根地址和模型名称。修改后重启服务。API Key 由本机 Node 服务读取，`model.config.json` 已加入 `.gitignore`。

模型模式每局由对话模型生成谜底、四个核心词以及各自的近义候选。服务端按余弦相似度挑出每组最接近的候选，让它们依次进入提示。如果恶龙漏用本轮指定的词，游戏会显示预先写好的、含该词的线索。提示中的意象表情会留在屏幕右侧的「已知线索」里，新开一局时清空。服务端缓存谜底向量，每轮将玩家理由的向量和它做余弦相似度比较，匹配度为 `clamp((相似度 - similarityFloor) / (1 - similarityFloor), 0, 1) × 100`，四舍五入。默认 `similarityFloor` 为 `0.2`，`winScore` 为 `72`。更换向量模型后可以在配置里调这两个值。

`prompts.mjs` 定义出题、反驳与提示、通关台词。每轮对话模型根据玩家的理由和最近四轮对话，以恶龙的口吻即时回应。接口失败时，页面保留玩家的输入供重试。

几轮没猜中、匹配度接近通关或猜测已经覆盖约一半初始关键词时，服务端会回看玩家猜过的内容，从谜底未覆盖的部分补一条线索。新增关键词与开局关键词采用相同的近义词筛选逻辑。复查失败时，该回合沿用已有线索。

每局完成五轮对话后，右上角的「显示答案」才可使用。这个按钮只读取本局已经生成的谜底。开新一局会重新锁定。
