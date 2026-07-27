# 知库 · 个人 RAG 学习知识库

知库是一个本地运行的个人学习知识库：按科目管理 PDF、PPTX、DOCX、TXT 和 Markdown 资料，自动解析、切片和向量化，并通过 OpenAI 兼容接口进行带来源引用的流式问答。

> 本项目默认仅监听 `127.0.0.1`。上传的原始文件、聊天记录、向量索引和 API Key 均保存在本机 `data/` 目录中，不会提交到 Git。

## 功能

- **科目管理**：每个科目拥有独立资料库、模型配置和对话记录
- **资料入库**：拖拽上传并显示解析、切片和向量化进度
- **兼容多种模型服务**：可配置任意 OpenAI 兼容的 Base URL、对话模型和向量模型
- **本地向量模型**：内置 `BAAI/bge-small-zh-v1.5`，使用 ONNX CPU 推理；首次使用下载约 100 MB
- **检索增强问答**：流式输出、Markdown 展示、来源文件和页码引用
- **检索测试与索引重建**：可检查命中片段，并在切换向量模型后重建索引

## 运行要求

- Python 3.9 或更高版本（当前使用 Python 3.9.6 验证）
- 首次安装依赖及首次加载本地向量模型时需要联网
- 网页版支持 macOS、Linux 和 Windows；项目内的桌面启动器仅支持 macOS 11+
- 扫描版 PDF 需要先进行 OCR；旧版 `.doc` / `.ppt` 需要另存为 `.docx` / `.pptx`

## 快速开始

### 网页版

macOS / Linux：

```bash
git clone 'https://github.com/Mant1ssa-smf3kt/-.git' zhiku
cd zhiku
./run.sh
```

`run.sh` 会创建 `.venv`、安装锁定版本的依赖并启动服务。浏览器打开 <http://127.0.0.1:8000>。

指定其他 Python 或端口：

```bash
PYTHON=python3.11 PORT=9000 ./run.sh
```

Windows（PowerShell）：

```powershell
py -3.9 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### macOS 桌面版

克隆仓库后，双击项目根目录中的 `知库.app`。桌面启动器依赖同级的 `backend/`、`frontend/`、`assets/` 和 `requirements.txt`，因此不要把 `.app` 单独移出项目目录。首次启动会自动创建虚拟环境并安装依赖；日志位于 `~/Library/Logs/zhiku.log`。

如果 macOS 阻止首次打开，可在 Finder 中右键 `知库.app`，选择“打开”。也可以直接使用网页版启动方式。

## 使用方法

1. 在“全局设置”中添加 OpenAI 兼容服务，填写 Base URL 和 API Key。
2. 选择默认向量模型和对话模型；也可启用内置本地向量模型。
3. 新建科目并上传资料，等待状态变为“已完成”。
4. 在“学习问答”中提问，并核对回答下方的来源引用。

## 数据与隐私

应用运行后会在 `data/` 中保存：

- `kb.sqlite`：科目、模型服务配置、**未加密的 API Key**、聊天记录和向量索引
- `files/`：上传的原始资料
- `models/`：下载的本地向量模型

`data/`、本地数据库、虚拟环境、日志、编辑器设置和常见密钥文件已被 `.gitignore` 排除。请注意：

- 不要删除 `data/`，除非你明确希望清空所有本地资料和配置。
- 不要通过网盘、公开压缩包或 Git 手动分享 `data/`。
- 只在受信任的个人设备上运行；本项目当前不提供 API Key 的系统钥匙串或数据库加密。
- 将服务暴露到局域网或公网前，需要额外添加认证、访问控制、TLS、上传隔离和速率限制。
- AI 回答可能出错，重要内容应回查引用原文。

可通过环境变量将运行数据放到其他目录：

```bash
RAG_DATA_DIR="$HOME/.local/share/zhiku" ./run.sh
```

## 开发与测试

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m compileall -q backend tests
.venv/bin/python -m unittest discover -s tests -v
bash -n run.sh
node --check frontend/app.js
```

测试使用临时数据目录，不会读取或修改本机 `data/`。GitHub Actions 会在 Python 3.9 环境中执行同样的核心检查。

## 项目结构

```text
backend/       FastAPI API、SQLite 存储、文档解析、向量检索与模型客户端
frontend/      零依赖单页前端
assets/        应用图标
知库.app/      macOS 桌面启动器（需保留在项目根目录）
tests/         核心逻辑与 API 自动化测试
run.sh         macOS / Linux 一键启动脚本
data/          本地私有运行数据（自动创建，已被 Git 忽略）
```

## 技术栈

- FastAPI、Uvicorn、SQLite（WAL）
- NumPy 余弦相似度检索
- fastembed / ONNX Runtime 本地向量化
- 原生 HTML、CSS 和 JavaScript
- pywebview macOS 桌面窗口

## 许可证

本仓库目前未附加开源许可证。公开可见不等于授权复制、修改或再分发；除非仓库所有者另行添加许可证，否则保留所有权利。
