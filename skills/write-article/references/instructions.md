# 指引

仅使用内联样式(<span>标签)，将文章内容通过卡片模板进行编写，一段一个卡片，最终输出文件格式为md。

## 标题卡片
```html
<span style="background: #0a0a0a; border-radius: 12px; padding: 20px 30px; box-shadow: 0 8px 32px;display: block;text-align: center;margin: 0 auto;">
<span style="
    background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%);
    color: #FEEBE7;
    font-size: 13px;
    font-weight: 700;
    display: inline-block;
    padding: 8px 16px;
    border-radius: 25px;
    letter-spacing: 2px;
    text-transform: uppercase;
    border: 1px solid rgba(254, 235, 231, 0.1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    margin-bottom: 12px;
">Claude Code 源码拆解系列</span>
  <span style="color: #FEEBE7; font-size: 20px; font-weight: 700; margin: 4px 0 12px 0; line-height: 1.2; display: block;text-align: center;">Agent 子代理：让 AI 自己派活</span>
  <span style="color: #bbb; font-size: 16px; border-top: 2px solid #666; padding-top: 12px; font-weight: 300; display: block;">第五篇 · 多 Agent 协作的核心起点</span>
  </span>
<span style="display: block; height: 1px; background: linear-gradient(to right, transparent, #333, transparent); margin: 20px;"></span>
```

## 内容卡片模板示例
```html
<span style="background: #0a0a0a; border-radius: 12px; padding: 20px 30px; box-shadow: 0 8px 32px;display: block;text-align: center;">
    <span style="
    background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%);
    color: #FEEBE7;
    font-size: 13px;
    font-weight: 700;
    display: inline-block;
    padding: 8px 16px;
    border-radius: 25px;
    letter-spacing: 2px;
    text-transform: uppercase;
    border: 1px solid rgba(254, 235, 231, 0.1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    margin-bottom: 12px;
">§1</span>
  <span style="color: #FEEBE7; font-size: 20px; font-weight: 700; margin: 4px 0 12px 0; line-height: 1.2; display: block;text-align: center;">什么是 Harness?</span>
  <span style="color: #bbb; font-size: 16px; border-top: 2px solid #666; padding-top: 12px; font-weight: 300; display: block;">概念</span>
  <span style="color: #ccc; font-size: 14px; font-weight: 400; margin: 16px 0 12px 0; line-height: 1.6; display: block;text-align: left;">"Harness"是<span style="font-weight:700">Agent的控制框架</span>。就像骑马需要缰绳来控制方向和节奏一样，AI Agent（特别是长时间工作的Agent）也需要一套"缰绳"来确保它们能持续、稳定地完成任务，OpenAI团队称之为"Harness"。
<br>优秀的harness如：superpowers, deer-flow, claude code</span>
</span>
<span style="display: block; height: 1px; background: linear-gradient(to right, transparent, #333, transparent); margin: 20px;"></span>
```

## 图片
如果想要/需要插入图片，可以先留空。
## 代码块
对于函数、代码等应当使用代码块标签:
```html
<span style="font-family: monospace; color: #98c379; background: #1e1e1e; padding: 2px 4px; border-radius: 4px;  white-space: pre;">if/else</span>
```
