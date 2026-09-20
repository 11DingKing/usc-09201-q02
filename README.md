# 经营权流转协商台

集体林权改革场景下的经营权流转协商后端：提案版本、意见表态、远程授权、地块退出、异议留痕与最终文本围绕同一版本推进，达到法定参与条件后方可定稿进入签署。

- 运行：`npm start`，健康检查 `GET /health`
- 测试：`npm test`（领域场景 25 项 + HTTP 端到端 4 项）
- 接口与规则：见 [docs/api.md](docs/api.md)
- 领域约定：见 [docs/domain.md](docs/domain.md)

## 架构

```
src/
  domain/
    store.mjs    只追加事件存储（全局连续 seq）
    models.mjs   纯函数事件投影（可重放、可审计）
    rules.mjs   授权时效/范围、一户一票、法定比例等纯规则
    service.mjs 命令处理 + 幂等 + 按角色脱敏的查询视图
    clock.mjs   系统时钟/手动时钟（到期判定可重复）
    errors.mjs  稳定错误码
  http/
    router.mjs  REST 路由、角色头、Idempotency-Key
```

所有变更以不可变事件留存，村集体可通过 `GET /api/events` 完整重放核对；任何对外汇总都按角色脱敏，不暴露无权查看的家庭资料。
