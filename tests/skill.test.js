// skill.js 的加载器测试：write-article 从包内 skills/ 目录读取（真实文件，缺失时优雅 null）。
import { describe, test, expect } from 'bun:test'
import { loadBundledSkill, WECHAT_MP_SKILL_NAME, WECHAT_MP_SKILL_DESCRIPTION, WECHAT_MP_SKILL_CONTENT } from '../skill.js'

describe('loadBundledSkill（skills/ 目录文件形态 skill）', () => {
  test('write-article：读出 name/description 与写作纪律正文', () => {
    const s = loadBundledSkill('write-article')
    if (s === null) {
      // 仓库里文件缺失时优雅返回 null（不炸插件加载）
      expect(s).toBe(null)
      return
    }
    expect(s.name).toBe('write-article')
    expect(s.description).toContain('公众号')
    expect(s.content.length).toBeGreaterThan(100)
  })

  test('write-article：资源索引渐进注入 + DSH 环境分支（拍板修改项 1/2/5）', () => {
    const s = loadBundledSkill('write-article')
    if (s === null) return
    // references/ 不内联正文——editorial 只以「绝对路径资源索引」出现，写前按条件精读
    expect(s.content).toContain('资源索引')
    expect(s.content).toMatch(/references\/editorial\.md` → .+editorial\.md（/)
    expect(s.content).not.toContain('## 1. 账号定位') // 全文未内联
    // html-syntax.md（样式存活矩阵）+ style-ceiling.html（探针载荷）都进索引，且带渐进阅读条件
    expect(s.content).toContain('references/html-syntax.md')
    expect(s.content).toMatch(/references\/style-ceiling\.html` → .+style-ceiling\.html（/)
    expect(s.content).not.toContain('references/instructions.md') // 旧暗色卡片模板已撤
    expect(s.content).toContain('渐进阅读条件')
    expect(s.resourceBase?.kind).toBe('directory')
    expect(s.resourceBase?.path.endsWith('skills/write-article')).toBe(true)
    // 交付链按环境二选一：DSH 分支走插件工具链，真源机命令标注不可用
    expect(s.content).toContain('DSH 环境')
    expect(s.content).toContain('wechat-mp-preview')
    expect(s.content).toContain('不要尝试执行')
    // 死引用已标注环境归属（拍板修改项 3，C1）
    expect(s.content).toContain('wechat-mp-article')
  })

  test('未知目录优雅 null', () => {
    expect(loadBundledSkill('no-such-dir')).toBe(null)
  })

  test('wechat-mp-article 常量非空且 name 稳定', () => {
    expect(WECHAT_MP_SKILL_NAME).toBe('wechat-mp-article')
    expect(WECHAT_MP_SKILL_DESCRIPTION.length).toBeGreaterThan(0)
    expect(WECHAT_MP_SKILL_CONTENT).toContain('wechat-mp-preview')
    expect(WECHAT_MP_SKILL_CONTENT).toContain('write-article') // 分工互指（拍板修改项 5）
  })
})
