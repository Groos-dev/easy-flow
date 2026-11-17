# 会话复盘来源

先用 `req session ls` 固化需求与登记会话清单。以需求范围选择会话，保留其跨月历史；登记当前归属与会话内部的历史工作归属分别记录。

## 读取来源

以下是本机2026-11验证过的存储入口；客户端版本变化时先核实际路径和schema，所有源只读。

| 客户端 | 入口与正文 |
|---|---|
| Claude | desktop的`claude-code-sessions/.../local_*.json`取cliSessionId，再找`~/.claude/projects/.../<cliSessionId>.jsonl` |
| Codex | `~/.codex/state_5.sqlite`的threads确认rollout_path/history_mode；已迁移会话从`thread_history_1.sqlite`的thread_items按rollout_ordinal读item_json |
| Cursor | JSONL与`Library/Application Support/Cursor/User/globalStorage/state.vscdb`合读；cursorDiskKV的bubbleId会话前缀包含正文及工具，composer headers/createdAt辅助恢复顺序 |
| 程小帮 | `~/.chengxiaobang/data/chengxiaobang.sqlite`的messages按created_at与稳定行序读，结合content和payload还原正文、toolCall、toolResult |

- Claude的attachment.queued_command也含中途输入：origin.kind=human/humanTurn为人类指令，task-notification为任务通知。两类都检查，角色分别保留。
- 工具镜像按tool_use_id/call_id识别；索引记录条数不等于去重调用量。
- Cursor的toolFormerData.result可能为JSON字符串，终端内容在解析后的output；空result不是可验证输出。KV还可能包含JSONL未保存的后续正文，要补审最终回合。
- Codex优先读原始消息与工具记录；turn摘要不能代替完整会话。私有推理和重复系统提示不作为用户决定。

## 关联与结论

明确属于本需求的未登记验证子会话，能定位时补审；共享会话只计一次，并把相关阶段挂到对应需求。会话曾改绑时按内部工作时点区分归属，不能把整条历史都归给最后一个需求。

逐会话列出已读正文、调用/结果、补充源及缺失内容，保留原消息ID、源文件/导出行号。只引用必要且脱敏的摘录，报告不保存Cookie或密钥。

结论区分Skill真实缺口、可复用知识、现行已覆盖、证据不足。先读现行Skill再建议改动；一次案例保留版本和条件。测试、门禁、合入、发布与业务验收分别陈述。用户结束跟踪或暂挂时，记录收尾原因及明确保留的恢复待办。
