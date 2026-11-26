---
name: article-writer
description: 公众号文章写作与排版（暗色卡片内联样式 HTML，一段一卡片，产物为 md 文件）。Use when user say 写公众号文章/公众号排版/微信推文/排成卡片/做成公众号样式. 仅限公众号目标——博客文章（写博客/写文章/写笔记/写解读）走 blog-writing skill。
---

# article-writer

## Overview

1. 根据用户发出的文章内容，进行 html 输出，输出格式及规范参考 @instructions.md
2. 输出目录：用户指定为准；未指定时输出到当前工作目录
3. 现有色板（#0a0a0a 卡底 + #FEEBE7 主文字）适配「Claude Code 源码拆解」类技术专栏；其他专栏可让用户给色板后套同款卡片结构
4. 配合本插件的 wechat-mp-draft-create / wechat-mp-publish 工具，可把排版好的 md（内联样式 HTML）直接推进公众号草稿箱或提交发布

## 风格约束
- 尽量少使用比喻
- 可以适当使用平稳的语气词
