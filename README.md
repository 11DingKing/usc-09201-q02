# 经营权流转协商台

本项目提供集体林权改革与林下产业协作领域的服务入口：提案、意见、授权、异议与最终文本围绕同一文本版本推进，达到法定参与条件后方可进入签署。业务数据与敏感配置应存放在受控环境中。

## 运行

```bash
npm start          # 启动服务，默认端口 3000（PORT 环境变量可改）
npm test           # 运行全部行为测试
```

- `GET /health` 确认服务状态。
- 除健康检查外，所有接口通过请求头 `x-actor-id` 识别身份；内置引导账号 `official-root`（村集体管理员）。
- 默认数据保存在内存中；设置 `DATA_FILE=/path/to/data.json` 后写操作自动落盘，重启恢复。

## 目录

- `src/server.mjs` — HTTP 层：路由、身份识别、统一错误格式
- `src/services/negotiation-service.mjs` — 全部业务规则（版本绑定、法定人数、委托、退出、隐私）
- `src/store/memory-store.mjs` — 内存存储 + 审计日志 + 可选落盘
- `docs/domain.md` — 领域规则约定（确定性规则逐条说明）
- `docs/api.md` — 接口参考与错误码
