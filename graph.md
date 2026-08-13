# 知库 · 知识图谱与增强 RAG（精简规格）

> **SSOT**：只写「做什么、状态怎么走、什么时候算完」。开发编排见 [`workflow.md`](./workflow.md)。  
> **原则**：成熟技术 · 默认零配置 · Agent 可自主拍板细节 · **能砍则砍**  
> **v2** · 2026-07-28 · **W1–W3 已实现**（规则图 + 可视化/主题 + Hybrid；LLM 抽图开关占位默认关）

---

## 1. 已锁定决策

| 议题 | 决定 | 原因 |
|---|---|---|
| 实体/关系从哪来 | **默认规则 + 共现**；已配置对话模型时**可选** LLM 增强（设置里开关，默认关） | 懒人零配置、省 token、离线可用；LLM 是加成不是门槛 |
| 主题分类 | **自动发现**（向量聚类 + 命名）；用户可改名/固定 | 不预置标签树 |
| 前端图谱 | **vis-network CDN**（单 script，不引入构建链） | 成熟、省自研力导向坑；与「原生 SPA」兼容 |
| 图存储 | SQLite 表，科目隔离 | 与现架构一致 |
| 触发 | `documents.status=ready` 后异步建图 | 不拖慢入库 |

非目标（v1 不做）：Neo4j、跨科目融合、多用户协作、chunk 级标签 UI、深度>2 的大图浏览。

---

## 2. 用户能感知什么（完成定义）

1. **上传完成后**自动出图/出标签，无需多步向导；失败有「重试」，不挡问答。  
2. **科目页**能打开「知识图谱」：点节点看到来源片段。  
3. **资料列表**能按自动主题筛选。  
4. **问答**默认走 Hybrid（向量 + 图加成）；图画不好时**静默退回纯向量**，行为不差于今天。

---

## 3. 数据模型（最小）

**节点**：`Entity`（科目内规范化名）、`Topic`  
**边**：`MENTIONS`(chunk→entity)、`CO_OCCURS`(entity↔entity)、`RELATES`(可选 LLM)、`ABOUT`(doc→topic)  
**仍用现表**：Document / Chunk / embedding 不搬迁。

**新表（概念名即可，实现时 migrate）**

```text
graph_jobs(id, subject_id, document_id, status, attempt, error, checkpoint, ...)
entities(id, subject_id, name, norm_name, type, ...)
entity_mentions(entity_id, chunk_id, score, extractor)
relations(id, subject_id, src, dst, rel_type, weight, evidence_json)
topics(id, subject_id, name, locked, ...)
doc_topics(document_id, topic_id, score)
graph_meta(subject_id, version, status, counts_json, updated_at)
```

实体类型先固定短枚举：`Term | Concept | Person | Other`（规则分得粗没关系）。

---

## 4. 状态机（两层够用）

### 文档 `graph_status`

```text
none → pending → building → ready
                      ↘ error → pending（重试）
删文档 → 清关联 → none
```

`building` 内部顺序固定，**不对外暴露子状态**：  
`抽取 mentions → 归一实体 → 写共现/关系 → 文档主题 →  bump version`

### 科目 `graph_meta.status`

```text
idle | building | ready | degraded
```

- 有任务在跑 → `building`  
- 至少部分 ready、可查询 → `ready` 或 `degraded`（有 error 文档）  
- 无资料 → `idle`

### 任务 `graph_jobs.status`

`pending → running → done | failed`（max_attempt=3，可重试错误才重试）

**并发**：Graph 专用 `Semaphore(1)`；与 ingest 的 Semaphore 分开；写库仍走现有 RLock。

---

## 5. 管线（4 步，不是 8 个微服务）

挂载点：现有 `ingest` 成功 `ready` 后 `enqueue(doc_id)`。

| 步 | 做什么 | 产出 | 失败策略 |
|---|---|---|---|
| **1 抽取** | 规则：书名号/引号术语、高频专名启发式；可选 LLM JSON（需开关+chat 配置）。实体名必须能在 chunk 原文命中（grounding） | mentions 草稿 | LLM 挂 → 仅规则；全空允许 |
| **2 归一** | norm 名、同科同 type 合并 | `entities` + `entity_mentions` | 不跨科目、不跨 type 瞎合并 |
| **3 建边** | 同 chunk（及邻接 seq）共现 → `CO_OCCURS`；LLM 关系 → `RELATES`（可选） | `relations` | 丢自环、无端点边 |
| **4 分类** | 用已有 chunk 向量聚成主题（科目级增量即可）；doc 投票贴标签；`locked` 主题名不覆盖 | `topics` + `doc_topics` | 无向量 → 跳过分类，图仍可 ready |

**幂等**：同文档重跑先删该文档的 mentions/其独占证据，再写；`graph_meta.version++`。

---

## 6. Hybrid 检索（叠在现有 `search_subject` 上）

```text
候选 = 向量 top_(max(3k,15))
若 graph ready：
  问题里命中的实体 → 1 跳邻居 → 关联 chunk 加分
  若有主题过滤 → 限制 document 集合
score = 0.75*向量 + 0.25*图加成（无图则纯向量）
再截断到 subject.top_k
```

边界：图 `building` 时用上一 `version` 或纯向量；不阻塞聊天。

---

## 7. API（少而全）

```text
GET  /api/subjects/{sid}/graph          # status, version, counts
POST /api/subjects/{sid}/graph/rebuild  # 整科重建
GET  /api/subjects/{sid}/graph/view     # nodes, edges（depth≤2, limit≤200）
GET  /api/subjects/{sid}/topics
GET  /api/subjects/{sid}/topics/{tid}/documents
POST /api/documents/{id}/graph/retry

聊天 body 增加 use_graph?: bool  # 默认 true
```

前端：设置里「LLM 增强抽图」开关；科目「知识图谱」「按主题」；失败「重试」。无向导、无强制配置。

---

## 8. 交付波次（3 刀切完，禁止拆成 6 期空转）

| 波次 | 范围 | 验收（有证据再宣称完成） |
|---|---|---|
| **W1 能转** | 表 + job + 状态 + 规则实体 + 共现 + 级联删除 + ingest 挂载 | ready 文档自动 pending→ready；删文档无孤儿；单测 mock |
| **W2 能看能筛** | graph/view API + vis-network 页 + 自动 topics + 列表筛选 | 真资料可见图；点击回源；可按主题滤文档 |
| **W3 更好答** | Hybrid 检索 + 可选 LLM 抽取开关 | 关图=旧行为；开图不炸；1～2 个对比问法体感/抽检 |

每波次打穿「库→API→（必要）UI→测」，不预建抽象层。

---

## 9. 硬边界速查

- 实体必须 grounding；未命中原文 → 丢弃  
- 科目隔离；可视化 depth≤2、节点 limit≤200  
- 无 chat / 关 LLM 开关 → 规则路径仍可用  
- 图失败 ≠ 文档 error；问答永远可降级  
- Python 3.9；不进 GPU/图数据库  

---

*改产品行为先改本文；实现 PR 用波次号 W1/W2/W3。*
