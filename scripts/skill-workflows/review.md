# Review 与研究回写

用户要求记录知识问题、研究待确认内容、保存 query、生成 digest 或管理候选及历史时读取本指南。正文由当前宿主生成；命令只负责本地校验、保存候选和发布，不配置模型或联网服务。

## 问题与候选分开

`lint` 默认仍是只读检查。用户要求跟踪问题，或明确要求研究处理时，才把问题写入 `.wiki-review/`。不要把启发式告警直接当成已确认事实。

```bash
node "${SKILL_DIR}/scripts/review-cli.js" add "${WIKI_PATH}" --type contradiction --title "待核对的问题" --reason "两处资料的说法不同" --path "wiki/topics/某主题.md" --packet "${PACKET_PATH}" --json
node "${SKILL_DIR}/scripts/review-cli.js" list "${WIKI_PATH}" --status open --json
node "${SKILL_DIR}/scripts/review-cli.js" show "${WIKI_PATH}" --id "${ISSUE_ID}" --json
node "${SKILL_DIR}/scripts/review-cli.js" dismiss "${WIKI_PATH}" --id "${ISSUE_ID}" --json
```

类型为 `contradiction`（矛盾）、`duplicate`（重复）、`missing`（缺页）、`unverified`（待确认）、`suggestion`（建议）。问题身份包含原因、路径与当前资料版本；旧版本已解决或搁置，不会屏蔽资料变化后的新问题。

## 研究与生成

1. 根据问题检索并核验证据包，见 [检索指南](query.md)。需要原始依据时使用 raw 模式。若材料不足，把缺失证据列为待验证；不虚构结论，不擅自联网补充。
2. 将研究正文写到临时文件（只放 Markdown 正文，不带 YAML frontmatter）。按问题选择综合报告、对比或时间线格式；引用证据 ID、相对路径和行号，区分原始主张、推论和未解决问题。命令生成标题、衍生标记和来源信息；query 使用模板的正文部分。
3. 将结果保存为候选。目标是 `wiki/` 下的 Markdown，不能写 `raw/`；研究结果标为衍生内容。可关联一个待处理问题。

```bash
node "${SKILL_DIR}/scripts/review-cli.js" stage "${WIKI_PATH}" --title "主题研究" --target "wiki/synthesis/主题研究.md" --body "${BODY_PATH}" --packet "${PACKET_PATH}" --issue "${ISSUE_ID}" --json
node "${SKILL_DIR}/scripts/review-cli.js" show "${WIKI_PATH}" --id "${CANDIDATE_ID}" --json
```

未关联问题时省略 `--issue`。重复主题先检查已有页面，由用户选择更新同一路径或新建。更新已有页面时，使用 raw 或其他页面作为证据；不要将即将覆盖的目标页放进引用包，否则采用本身会使引用失效。目标旧版单独保留用于比较。候选保留固定来源、正文哈希和原目标内容；生成完成不代表采用，正式页面、索引和日志此时不变。

## 采用与恢复

向用户展示目标路径、候选正文、与原版的差异和证据限制。用户已明确要求保存或采用时，执行采用；否则停在候选，不额外要求重复授权。

```bash
node "${SKILL_DIR}/scripts/review-cli.js" adopt "${WIKI_PATH}" --id "${CANDIDATE_ID}" --json
```

采用前重新校验原文、目标版本与关联问题绑定的资料版本；恢复也执行这些检查。来源或目标已被外部修改时，保留候选，重新检索并生成新候选，不修改记录中的哈希以绕过冲突。成功采用后才报告页面、根 `index.md`、`log.md` 已更新，并解决关联问题。衍生页不能作为一手素材再次 ingest；后续引用其推论仍按 `INFERRED` 处理。

采用先持久化固定发布清单，再依次更新文件。意外中断后运行：

```bash
node "${SKILL_DIR}/scripts/review-cli.js" recover "${WIKI_PATH}" --json
```

恢复只重放已保存内容，不重新调用模型；已写入的相同内容会被识别，重复采用不重复追加日志。未知文件改动会阻止恢复并保留记录。锁仍由活动进程持有时先等待该命令完成；恢复只会清理由同机已退出进程留下的锁，不手工删除未知锁。

若恰好在清理死进程锁时再次中断，可能留下 `.wiki-review/lock-recovery`。先停止所有 Review／归档命令，核对该文件的主机与 PID，证明同机进程已退出后才能移除这个保护文件，再运行 `recover`；无法确认时保留现场。

## 取消与替代候选

用户要求放弃尚未采用的候选时，可取消；取消保留原始内容及原因，不改正式页面，也不解决关联问题。

```bash
node "${SKILL_DIR}/scripts/review-cli.js" cancel "${WIKI_PATH}" --id "${CANDIDATE_ID}" --reason "本次不再采用" --json
node "${SKILL_DIR}/scripts/review-cli.js" supersede "${WIKI_PATH}" --id "${OLD_CANDIDATE_ID}" --replacement "${NEW_CANDIDATE_ID}" --json
```

替代需明确指定同一目标的两个待采用候选，不能用不同页面的候选替代；新候选仍需核对后采用。已采用记录不能取消或作为待采用候选替代。取消／被替代候选不可采用；需要继续研究时重新检索并生成新候选，不修改已保存历史的状态或哈希。

## 历史与容量

```bash
node "${SKILL_DIR}/scripts/review-cli.js" list "${WIKI_PATH}" --scope all --candidate-status ready --limit 100 --offset 0 --json
node "${SKILL_DIR}/scripts/review-cli.js" list "${WIKI_PATH}" --scope history --status all --limit 100 --offset 0 --json
node "${SKILL_DIR}/scripts/review-cli.js" compact "${WIKI_PATH}" --json
```

活动候选与历史分开保存；新问题或候选被接受前会整理已完成记录，也可显式执行 `compact`。活动状态仍有 500 个问题、100 个候选的上限，正文 256 KiB；历史索引最多 10000 条，分页查看结果，超出预算时明确报告。累计已采用、取消或被替代的历史不会继续占满活动候选容量；仍被活动候选引用的问题要保留必要关联。

整理先备份终态记录及已提交发布日志，再保存可核验历史索引、收缩活动状态，最后移除已备份且哈希一致的热日志。中断后停止并发编辑，重新运行 `compact`；一致的中间副本可继续整理，未知改动会阻止覆盖。存在未完成正式发布时先运行 `recover`，不要手动删除记录来腾容量。

历史的 `show` 仍可查看原内容及当前证据核验结果；旧依据可能过期，按 [新鲜度指南](freshness.md) 单独判断。重复采用已采用的历史只返回既有结果，不重写页面。`.wiki-review/` 的活动与历史均随知识库归档；不依赖客户端。

Node 不可用时先展示研究草稿，说明自动校验／恢复不可用；保留用户手动保存的选择，不自动安装依赖。
