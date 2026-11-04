# Markdown 保真入库与手动更新

用户提供本地 Markdown，或要求检查已入库 Markdown 的变化时读取。此流程由当前宿主生成摘要，本地脚本只读取、保存、校验及发布；不启动客户端或自动监听。

## 先确认来源范围

把用户给出的文件夹作为 `SOURCE_ROOT`，主 Markdown 使用根内相对路径 `SOURCE_FILE`。用户只提供单文件时默认使用其父目录；若它引用上级目录附件，列出缺失范围，让用户指定能够包含这些资料的根目录后继续。不要擅自读取其他目录。

首次素材隐私确认仍按 ingest 通用规则；当前会话已明确授权的素材、目录和操作不重复确认。不要更改全局库指针或安装依赖。

## 保真捕获

```bash
node "${SKILL_DIR}/scripts/markdown-cli.js" inspect --source-root "${SOURCE_ROOT}" --file "${SOURCE_FILE}" --json
node "${SKILL_DIR}/scripts/markdown-cli.js" capture "${WIKI_PATH}" --source-root "${SOURCE_ROOT}" --file "${SOURCE_FILE}" --json
```

先查看依赖和覆盖报告。标准 Markdown 链接／图片、引用式链接、Wiki 双链／嵌入及相关本地文件在授权根内解析；代码块、行内代码与 YAML 中的示例不触发依赖抓取。原文、frontmatter、BOM／CRLF 与附件按原始字节保存，文件夹关系及同名附件分别保留。

脚本另外生成阅读副本，为已解析的本地引用使用捕获包内的明确路径。阅读副本用于打开资料，不冒充原始素材；原文不被路径改写。外部 URL 保持原样，不自动下载；缺失、歧义、越界、符号链接、无效编码或预算不足时明确报告，完整性不足不能继续采用。

返回的 sourceId 是资料稳定身份，revision 是固定素材版本。不要按日期或标题另建重复素材。捕获完成只表示资料包已保存，正式摘要此时尚未变化。

## 生成并采用摘要

读取捕获结果提供的原文及证据，按现有完整／简化 ingest 规则提取知识。先生成素材摘要正文到临时文件，不带 YAML 或受管标记。不要把阅读副本或宿主背景知识当成原文依据。

```bash
node "${SKILL_DIR}/scripts/markdown-cli.js" stage "${WIKI_PATH}" --id "${SOURCE_ID}" --revision "${REVISION}" --body "${BODY_PATH}" --title "资料标题" --json
node "${SKILL_DIR}/scripts/review-cli.js" show "${WIKI_PATH}" --id "${CANDIDATE_ID}" --json
node "${SKILL_DIR}/scripts/review-cli.js" adopt "${WIKI_PATH}" --id "${CANDIDATE_ID}" --json
```

摘要目标固定为 `wiki/sources/<sourceId>.md`。用户已要求消化并保存时可直接采用；只要求预览时停在候选。采用前会校验整个素材包及目标版本，包含二进制附件；成功后才报告摘要、根索引与日志已更新。实体、主题等后续知识整理继续使用既有 ingest 指引，不把它们的更新说成摘要发布脚本已自动完成。

摘要内的用户补充区用于手工笔记，后续更新原样保留。区外手工编辑、受管标记变化或候选生成后的新编辑会阻止覆盖；展示差异后重新整理，不静默丢弃内容。旧素材版本与采用历史继续保留。

## 主动检查变化

```bash
node "${SKILL_DIR}/scripts/markdown-cli.js" scan "${WIKI_PATH}" --source-root "${SOURCE_ROOT}" --json
```

扫描只读，列出新增、修改、改名、删除、未变化和待修复项。正文或附件改变都算变化；扫描不完整时不能据此宣布文件已删除。仅当旧路径消失且内容对应唯一时建议沿用资料身份，重复内容不猜测改名关系。

对选中的新增／变化项重新 capture、生成候选并采用。改名时沿用 sourceId，摘要路径不变；歧义时用 `--id` 指定身份。未变化且现有摘要有效时直接复用，不重新调用模型。原文删除只提示，不删除库内原文、摘要或历史。

来源集合只保存目录指纹与相对路径。迁移或恢复知识库后，用户须重新指定来源目录；需要沿用集合时显式传入 `--collection <集合ID>`，不自动读取旧机器的目录。

默认检索只使用经验证的当前采用版本；待采用、旧版和阅读副本不会重复充当原文事实。旧引用仍可显式核验；发现用户改动或状态不完整时报告限制，不能把未检索到解释为资料不存在。

需要检查资料更新对已有知识的影响时，读 [新鲜度指南](freshness.md)，只读列出直接旧版引用与潜在间接影响；用户要求跟踪后再创建 Review 问题。素材摘要采用不等于所有关联主题或研究结论已自动更新。

发布中断仍使用 [Review 恢复](review.md)。素材包、阅读副本、来源登记和采用历史随 [知识库归档](archive.md) 保存。Node 不可用时保留手动导入选择，并说明这些自动保真与更新保证不可用，不自动安装工具。
