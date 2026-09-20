# 接口与规则说明

## 角色与身份

演示环境通过请求头识别行为人与角色（生产部署须由认证中间件签发，不可直接信任客户端）：

- `x-actor-role: collective` —— 村集体
- `x-actor-role: company` + `x-actor-id: <公司ID>` —— 项目公司
- `x-actor-role: person` + `x-actor-id: <人员ID>` —— 家庭成员/受托人
- 无头或 `public` —— 村务公开视角

所有写接口支持 `Idempotency-Key` 头：同一键重放返回首次结果，不产生第二条表态/异议。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/companies` | 村集体登记项目公司 |
| POST | `/api/households` | 村集体登记户与家庭成员（跨村民小组用 `group` 区分） |
| POST | `/api/plots` | 登记地块，归属到户 |
| POST | `/api/proposals` | 公司发起提案（范围、截止时间、法定比例、v1 条款） |
| POST | `/api/proposals/:id/revisions` | 公司改价/改条款，生成新版本 |
| POST | `/api/proposals/:id/deadline-extensions` | 截止前顺延截止时间 |
| POST | `/api/grants` | 成员本人/村集体登记远程委托 |
| POST | `/api/grants/:id/revocations` | 委托人本人/村集体撤销委托 |
| POST | `/api/proposals/:id/plot-exits` | 少数地块退出 |
| POST | `/api/proposals/:id/statements` | 户表态（`consent`/`oppose`） |
| POST | `/api/proposals/:id/withdrawals` | 截止前撤回当前版本表态 |
| POST | `/api/proposals/:id/objections` | 登记异议（绑定版本，截止后标记 `afterDeadline`） |
| POST | `/api/proposals/:id/finalization` | 村集体在截止后且达法定比例时定稿 |
| GET | `/api/proposals/:id` | 提案视图（按角色脱敏） |
| GET | `/api/proposals/:id/group-tally` | 跨村民小组参与汇总 |
| GET | `/api/proposals/:id/objections` | 异议台账（公司只见分类计数） |
| GET | `/api/households/:id` | 单户明细（仅本户成员与村集体） |
| GET | `/api/events?fromSeq=` | 完整事件日志（仅村集体，可审计重放） |

## 确定结果规则

1. **事件溯源**：所有变更是只追加事件，`seq` 全局连续。并发命令按到达顺序串行落库，同刻争议以 `seq` 裁决。
2. **文本版本**：每次改价生成新版本；表态/异议绑定其作出时的版本；旧版本表态不继承到新版本。定稿锁定当前版本条款快照。
3. **一户一票**：同户同版本重复表态时旧票标记 `replaced`，恒以最后一条有效表态计票；撤回后该户回到待定，可重新表态。
4. **远程委托**：作出时同时校验状态（active）、到期时间（`expiresAt > now`）、动作范围（表态/异议/地块退出）、地块范围。撤销即时生效且不溯及既往；到期不影响到期前已作出的有效行为。
5. **地块退出**：退出地块从在范围面积与定稿快照中剔除；该户仍有在范围地块则保留参与资格，全部退出则失去资格；不可重复退出。
6. **法定比例**：基数为当前在范围地块涉及的户；截止后同意户/基数户达到 `threshold`（默认 2/3）才允许定稿。截止前不得定稿，定稿后禁止改价、表态与异议。
7. **脱敏**：公司与公开视角的任何汇总只含计数，绝不含户号、人员、异议内容或退出地块明细；家庭明细仅本户成员与村集体可见；完整事件日志仅村集体可调取。

错误统一返回 `{ error: <稳定code>, message, details? }`，关键判定（如未达比例的票数、授权失败的要素）写入 `details`。
