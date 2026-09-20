# API 参考

除 `GET /health` 外，所有接口都要求请求头 `x-actor-id: <成员编号>`。请求与响应均为 JSON。

错误响应统一为：

```json
{ "error": { "code": "ERROR_CODE", "message": "人类可读说明", "details": { } } }
```

## 基础

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（无需身份） |
| GET | `/me` | 当前身份、本户资料、地块与委托 |

## 基础资料（仅村集体）

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| POST | `/admin/households` | `{ name, groupId }` |
| POST | `/admin/actors` | `{ name, role, householdId? }`，`role` ∈ `village_official / enterprise / villager` |
| POST | `/admin/plots` | `{ name, householdId, area }` |

## 方案与文本版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proposals` | 企业或村集体发起方案（草稿）：`{ title, groupIds, plotIds, terms, deadline, quorum? }` |
| POST | `/proposals/:id/publish` | 发布方案，进入协商期 |
| POST | `/proposals/:id/cancel` | 作废方案（仅村集体） |
| GET | `/proposals` | 列出当前身份可见的方案 |
| GET | `/proposals/:id` | 方案详情（按角色裁剪地块明细） |
| GET | `/proposals/:id/versions` | 文本版本列表 |
| POST | `/proposals/:id/versions` | 改价/修订：`{ expectedVersion, terms }`，版本不符返回 `VERSION_CONFLICT` |
| POST | `/proposals/:id/enter-signing` | 达到法定参与条件后进入签署（仅村集体），否则 `QUORUM_NOT_MET` |

`terms` 结构：`{ pricePerMu, leaseYears, guaranteedIncome, exitTerms, notes? }`。
`quorum` 结构（可缺省，默认双三分之二）：`{ participationNum, participationDen, consentNum, consentDen }`。

## 表态（意见）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proposals/:id/statements` | `{ stance, comment?, onBehalfOf? }`，`stance` ∈ `consent / dissent / abstain`；重复提交相同内容幂等返回（200），不同内容返回 `DUPLICATE_STATEMENT` |
| GET | `/proposals/:id/statements` | 村集体看全部，农户只看本户，企业 403 |
| POST | `/statements/:id/withdraw` | 截止前撤回；截止后返回 `DEADLINE_PASSED` |

## 异议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proposals/:id/objections` | `{ reason, onBehalfOf? }` |
| GET | `/proposals/:id/objections` | 全员可见留痕，非村集体看到的提出方为匿名化信息 |
| POST | `/objections/:id/resolve` | `{ resolution }`（仅村集体） |
| POST | `/objections/:id/withdraw` | 提出方撤回 |

## 地块退出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proposals/:id/exits` | `{ plotIds, onBehalfOf? }`；村集体可传 `householdId` 指定农户 |

## 汇总与审计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/proposals/:id/summary` | 按角色裁剪：家庭明细仅村集体，农户含本户，企业仅聚合数字 |
| GET | `/proposals/:id/audit` | 完整审计留痕（仅村集体） |

## 委托授权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/delegations` | `{ delegatorId, delegateId, actions, proposalIds, validUntil }`；`actions` ∈ `statement / objection / exit`，`proposalIds` 为 `null` 表示不限方案 |
| GET | `/delegations` | 本人相关委托（村集体看全部），含 `expired` 标记 |
| POST | `/delegations/:id/revoke` | 撤销委托 |

## 主要错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 缺少有效身份 |
| `FORBIDDEN` | 403 | 角色无权操作 |
| `NOT_FOUND` | 404 | 资源不存在或不可见 |
| `VALIDATION` | 400 | 请求参数不合法 |
| `VERSION_CONFLICT` | 409 | 文本版本已被并发修改 |
| `DUPLICATE_STATEMENT` | 409 | 已存在有效表态，须先撤回 |
| `DEADLINE_PASSED` | 409 | 协商截止后变更 |
| `DELEGATION_EXPIRED` | 403 | 委托授权已到期 |
| `DELEGATION_REVOKED` | 403 | 委托授权已撤销 |
| `DELEGATION_SCOPE` | 403 | 超出委托范围 |
| `DELEGATION_EXISTS` | 409 | 两人之间已有有效委托 |
| `QUORUM_NOT_MET` | 409 | 未达到法定参与条件 |
| `NO_ELIGIBLE_HOUSEHOLDS` | 409 | 范围内已无符合条件的农户 |
| `NOT_PLOT_OWNER` | 403 | 地块不属于本户 |
| `PLOT_NOT_IN_SCOPE` | 409 | 地块不在方案范围内 |
| `INVALID_STATUS` | 409 | 当前状态不允许该操作 |
