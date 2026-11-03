# 知识库归档与恢复

用户要求备份、迁移或恢复知识库时读取本指南。归档包含纯 Skill 的知识库文件与 Review 历史，不需要客户端。Python 3.8+ 标准库即可运行，不安装压缩包或联网服务。

## 导出与校验

确认当前知识库；归档输出应位于库外，且不能覆盖已有文件。先完成正在运行的入库、编辑与发布；若存在未完成的 Review 发布，先按 [Review 指南](review.md) 恢复。

```bash
bash "${SKILL_DIR}/scripts/archive.sh" export "${WIKI_PATH}" --output "${ARCHIVE_PATH}" --json
bash "${SKILL_DIR}/scripts/archive.sh" verify "${ARCHIVE_PATH}" --json
```

wrapper 复用已有 Python 定位，在 Windows Git Bash 中也能选择 `python`。也可直接用可用的 Python 3 命令执行 `scripts/archive.py`，参数相同。

导出保存 `raw/`（含附件）、`wiki/`、根 Schema、研究方向、索引、日志、缓存，以及 `.wiki-review/` 的问题、候选、旧版与发布历史。根 `assets/`、`attachments/` 存在时也会保留。导出首次在 `.wiki-review/identity.json` 创建可移植的知识库身份，恢复后保持同一身份。

manifest 列出文件的规范相对路径、字节数与 SHA256；命令返回文件数、总字节数和排除项。检查 `excluded`，不要将被排除的其他项目文件误认为已备份。凭证、Git、工作台应用数据、进程锁和临时文件不属于此归档；外部资料路径不会授权读取库外内容。

导出与 Review 使用同一把锁，并在发布压缩包前重新核对文件，避免保存正在变化的内容。外部编辑器不会遵守这把锁，因此导出期间保持知识库静止；发现变化会失败，停止编辑后再导出。哈希校验用于发现损坏及内容不一致，不认证素材主张或归档提供者的身份。

## 恢复到新目录

```bash
bash "${SKILL_DIR}/scripts/archive.sh" restore "${ARCHIVE_PATH}" --target "${RESTORE_PATH}" --json
```

目标只能不存在或为空。先完整校验，再恢复到临时 staging，验证完成后发布到目标；越界路径、符号链接、Windows 非法名称、跨平台重名、缺失／额外文件、哈希错误、超出预算和未完成发布均会拒绝。失败不覆盖已有知识库。

原文、附件和 Review 内容按原始字节恢复，保留 CRLF 与中文路径。缓存是可重建数据，恢复后统一重置为 `version: 1` 的空缓存，并返回 `cacheInvalidated: true`；后续 ingest 按既有规则重建。恢复不修改全局知识库路径指针、不启动自动监听、不重新调用模型。

完成后读取恢复库的 Schema、索引及 Review 清单，再选择该目录继续工作。若要替换现有库，先恢复到新目录核对，由用户另外决定原库的处置。
