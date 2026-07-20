<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const activeScene = ref<'research' | 'build' | 'organize'>('research')
const colorMode = ref<'light' | 'dark'>('dark')
let revealObserver: IntersectionObserver | undefined

const scenes = {
  research: {
    index: '01',
    label: '调研与决策',
    title: '把散落的信息，变成可以行动的结论。',
    description: '检索网页、阅读资料、比对来源，再将结果整理成带有上下文的交付物。',
    goal: '调研 5 个同类产品，比较核心能力与定价，输出一页决策摘要。',
    steps: ['检索并筛选可信来源', '提取产品能力与价格信息', '生成对比矩阵和结论'],
  },
  build: {
    index: '02',
    label: '开发与交付',
    title: '从理解代码，到验证改动，一次走完。',
    description: '绑定项目工作区，让 Agent 在清晰边界内读代码、修改文件、运行检查并汇报结果。',
    goal: '定位登录页的移动端问题，修复后运行类型检查并总结改动。',
    steps: ['分析组件与样式依赖', '实施最小范围修复', '运行检查并整理变更'],
  },
  organize: {
    index: '03',
    label: '整理与创作',
    title: '重复的整理工作，交给一条持续执行的链路。',
    description: '处理本地文件与知识库，让归纳、改写、分类和生成内容成为可复用工作流。',
    goal: '整理本周会议材料，提取决策和待办，生成团队周报。',
    steps: ['读取材料并识别主题', '提取决策、负责人和期限', '生成结构化周报'],
  },
} as const

// 首页主题与文档主题保持同步，并单独保存用户选择。
function applyColorMode(mode: 'light' | 'dark', persist = true) {
  colorMode.value = mode
  document.documentElement.classList.toggle('dark', mode === 'dark')
  document.documentElement.style.colorScheme = mode
  if (persist) localStorage.setItem('aurevoy-color-mode', mode)
}

function toggleColorMode() {
  applyColorMode(colorMode.value === 'dark' ? 'light' : 'dark')
}

// 进入视口时添加状态类，避免为每个区块维护独立动画状态。
onMounted(() => {
  const savedMode = localStorage.getItem('aurevoy-color-mode')
  const initialMode = savedMode === 'light' || savedMode === 'dark'
    ? savedMode
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyColorMode(initialMode, false)

  if (!('IntersectionObserver' in window)) return

  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        revealObserver?.unobserve(entry.target)
      })
    },
    { threshold: 0.14 },
  )

  document.querySelectorAll<HTMLElement>('[data-reveal]').forEach((element) => {
    revealObserver?.observe(element)
  })
})

onBeforeUnmount(() => revealObserver?.disconnect())
</script>

<template>
  <div class="landing-page" :class="{ 'is-light': colorMode === 'light' }">
    <header class="landing-nav">
      <a class="landing-brand" href="/" aria-label="Aurevoy 首页">
        <span class="brand-symbol"><img src="/aurevoy-wordmark.svg" alt="" /></span>
        <span>Aurevoy</span>
      </a>
      <nav aria-label="主页导航">
        <a href="#product">产品</a>
        <a href="#scenes">场景</a>
        <a href="#control">安全与控制</a>
        <a href="/guide/introduction">文档</a>
      </nav>
      <div class="nav-actions">
        <a class="github-link" href="https://github.com/nullskymc/Aurevoy" target="_blank" rel="noreferrer">
          GitHub <span>↗</span>
        </a>
        <button class="theme-toggle" type="button" :aria-label="colorMode === 'dark' ? '切换到日间模式' : '切换到夜间模式'" :title="colorMode === 'dark' ? '切换到日间模式' : '切换到夜间模式'" @click="toggleColorMode">
          <svg v-if="colorMode === 'dark'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" /></svg>
        </button>
        <a class="nav-download" href="https://github.com/nullskymc/Aurevoy/releases">
          下载应用 <span>→</span>
        </a>
      </div>
    </header>

    <main>
      <section class="hero-section">
        <div class="hero-grid-lines" aria-hidden="true"></div>
        <div class="hero-aurora" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="hero-content">
          <a class="release-pill" href="https://github.com/nullskymc/Aurevoy/releases">
            <span class="live-dot"></span>
            Aurevoy v0.6.8 已发布
            <b>查看更新</b>
            <i>→</i>
          </a>
          <p class="hero-overline">LOCAL AI AGENT · OPEN SOURCE</p>
          <h1>不止回答问题。<br /><em>开始完成工作。</em></h1>
          <p class="hero-description">
            Aurevoy 是运行在你电脑上的个人 AI Agent。说出目标，它会理解上下文、制定计划、调用工具并持续推进，直到交付结果。
          </p>
          <div class="hero-buttons">
            <a class="primary-cta" href="https://github.com/nullskymc/Aurevoy/releases">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v13m0 0 5-5m-5 5-5-5M5 20h14" /></svg>
              下载桌面版
              <span>macOS · Windows · Linux</span>
            </a>
            <a class="secondary-cta" href="/guide/quickstart">
              <span class="play-icon">▶</span>
              看它如何工作
            </a>
          </div>
          <div class="hero-meta">
            <span><i>✓</i> 数据默认存储在本地</span>
            <span><i>✓</i> 自带模型 Key</span>
            <span><i>✓</i> MIT License</span>
          </div>
        </div>

        <div id="product" class="product-showcase">
          <div class="showcase-halo" aria-hidden="true"></div>
          <div class="actual-app-frame">
            <div class="actual-app-chrome"><div class="traffic-lights"><i></i><i></i><i></i></div><span>真实 Aurevoy 应用界面</span><b>v0.6.9</b></div>
            <img
              src="/aurevoy-app-home@2x.png"
              width="1440"
              height="900"
              alt="Aurevoy 真实应用首页，展示任务建议与自然语言目标输入框"
            />
          </div>
          <div class="floating-card float-card-one">
            <span class="float-icon approved">✓</span><div><b>操作已批准</b><small>仅允许本次文件修改</small></div>
          </div>
          <div class="floating-card float-card-two">
            <span class="float-icon">✦</span><div><b>3 个工具并行运行</b><small>任务仍在持续推进</small></div>
          </div>
        </div>
      </section>

      <section class="capability-marquee" aria-label="产品能力">
        <div class="marquee-track">
          <div v-for="repeat in 2" :key="repeat" class="marquee-set">
            <span><i>⌁</i> 网页检索</span><b>·</b><span><i>⌘</i> 终端工具</span><b>·</b><span><i>◇</i> 项目工作区</span><b>·</b><span><i>↗</i> 多 Agent 协作</span><b>·</b><span><i>◎</i> 记忆与知识库</span><b>·</b><span><i>✦</i> Skill 与 MCP</span><b>·</b>
          </div>
        </div>
      </section>

      <section class="value-section section-shell">
        <div class="section-heading" data-reveal>
          <span class="section-number">01 / PRODUCT</span>
          <h2>不是另一个聊天框。<br /><em>是一套完整的执行环境。</em></h2>
          <p>从理解目标到调用工具，从过程干预到结果交付，所有环节都在同一个可追踪工作台里完成。</p>
        </div>
        <div class="bento-grid">
          <article class="bento-card bento-large" data-reveal>
            <div class="card-copy"><span class="card-label">目标驱动</span><h3>给结果，不必给步骤。</h3><p>描述目标、边界和完成标准。Aurevoy 自主拆解任务，并根据真实进展调整路径。</p></div>
            <div class="goal-visual">
              <div class="goal-input"><span>帮我准备下周的产品评审材料</span><i>↑</i></div>
              <div class="goal-flow"><span>理解目标</span><i></i><span>制定计划</span><i></i><span>调用工具</span><i></i><span>交付结果</span></div>
              <div class="goal-result"><span>✓</span><div><b>评审材料已准备</b><small>产品简报 · 数据摘要 · 会议议程</small></div><i>查看结果 →</i></div>
            </div>
          </article>
          <article class="bento-card" data-reveal>
            <div class="card-copy"><span class="card-label">持续执行</span><h3>不会停在“建议你这样做”。</h3><p>它会真正读取、编辑、检索和运行工具，直到任务完成或需要你决定。</p></div>
            <div class="orbit-visual"><div class="orbit-core"><span class="brand-symbol orbit-symbol"><img src="/aurevoy-wordmark.svg" alt="" /></span></div><i class="orbit-line line-one"></i><i class="orbit-line line-two"></i><span class="orbit-node node-one">⌁</span><span class="orbit-node node-two">›_</span><span class="orbit-node node-three">M</span><span class="orbit-node node-four">◇</span></div>
          </article>
          <article class="bento-card" data-reveal>
            <div class="card-copy"><span class="card-label">过程可恢复</span><h3>复杂任务，也不怕中断。</h3><p>暂停、继续、编辑后重试、分支和上下文压缩，让长任务保持可控。</p></div>
            <div class="timeline-visual"><div class="timeline-line"></div><div class="timeline-item done"><i>✓</i><span><b>09:42</b>目标已确认</span></div><div class="timeline-item done"><i>✓</i><span><b>09:44</b>完成资料收集</span></div><div class="timeline-item active"><i></i><span><b>09:46</b>正在生成交付物</span></div><div class="timeline-item"><i></i><span><b>下一步</b>等待审阅</span></div></div>
          </article>
        </div>
      </section>

      <section id="scenes" class="scenes-section">
        <div class="section-shell scenes-shell">
          <div class="section-heading light" data-reveal>
            <span class="section-number">02 / USE CASES</span>
            <h2>一个 Agent，<br /><em>进入不同工作现场。</em></h2>
          </div>
          <div class="scene-layout" data-reveal>
            <div class="scene-tabs" role="tablist" aria-label="使用场景">
              <button v-for="(scene, key) in scenes" :key="key" :class="{ active: activeScene === key }" role="tab" :aria-selected="activeScene === key" @click="activeScene = key">
                <span>{{ scene.index }}</span><b>{{ scene.label }}</b><i>→</i>
              </button>
            </div>
            <div class="scene-copy" :key="activeScene">
              <span class="scene-eyebrow">{{ scenes[activeScene].label }}</span>
              <h3>{{ scenes[activeScene].title }}</h3>
              <p>{{ scenes[activeScene].description }}</p>
              <a href="/guide/introduction">查看使用指南 <span>→</span></a>
            </div>
            <div class="scene-demo" :key="`${activeScene}-demo`">
              <div class="demo-top"><span><i class="brand-symbol mini"><img src="/aurevoy-wordmark.svg" alt="" /></i> Aurevoy</span><b>正在执行</b></div>
              <div class="demo-goal"><small>你的目标</small><p>{{ scenes[activeScene].goal }}</p></div>
              <div class="demo-plan"><div v-for="(step, index) in scenes[activeScene].steps" :key="step" :class="{ running: index === 2 }"><i>{{ index < 2 ? '✓' : '' }}</i><span>{{ step }}</span><small>{{ index < 2 ? '完成' : '执行中' }}</small></div></div>
              <div class="demo-progress"><i><b></b></i><span>Agent 正在持续工作</span><time>01:24</time></div>
            </div>
          </div>
        </div>
      </section>

      <section id="control" class="control-section-new section-shell">
        <div class="control-copy" data-reveal>
          <span class="section-number">03 / CONTROL</span>
          <h2>能力越强，<br /><em>边界越要清楚。</em></h2>
          <p>Aurevoy 把“能做什么”和“是否允许做”分开。高风险动作在发生之前展示路径、参数和影响范围，由你决定。</p>
          <ul>
            <li><i>✓</i><span><b>本地优先</b>任务、记忆和知识库默认存储在你的设备。</span></li>
            <li><i>✓</i><span><b>逐次审批</b>文件修改、终端命令等敏感操作可设为确认后执行。</span></li>
            <li><i>✓</i><span><b>全程可见</b>计划、工具调用、耗时与结果都留下可追踪轨迹。</span></li>
          </ul>
          <a class="inline-link" href="/guide/permissions">了解权限模型 <span>→</span></a>
        </div>
        <div class="approval-stage" data-reveal>
          <div class="approval-glow"></div>
          <div class="approval-window">
            <div class="approval-title"><span>需要你的批准</span><i>高风险操作</i></div>
            <div class="approval-tool"><span class="tool-glyph">›_</span><div><b>执行终端命令</b><small>Agent 请求运行以下操作</small></div></div>
            <div class="command-block"><span>$</span><code>npm run build</code><button>复制</button></div>
            <dl><div><dt>工作目录</dt><dd>~/Projects/Aurevoy/docs</dd></div><div><dt>影响范围</dt><dd><span>只读构建</span></dd></div><div><dt>风险说明</dt><dd>将运行项目内定义的构建脚本</dd></div></dl>
            <div class="approval-buttons"><button>拒绝</button><button>允许本次</button></div>
          </div>
          <div class="security-chip chip-one"><i>✓</i><span><b>工作区边界</b><small>路径已验证</small></span></div>
          <div class="security-chip chip-two"><i>⌾</i><span><b>审计轨迹</b><small>操作可追溯</small></span></div>
        </div>
      </section>

      <section class="open-section">
        <div class="open-grid section-shell" data-reveal>
          <div class="open-copy"><span class="section-number">OPEN BY DESIGN</span><h2>你的 Agent，<br />不该是一个黑盒。</h2><p>Aurevoy 开源、模型可选、工具可扩展。你可以检查它如何工作，也可以让它适应自己的工作流。</p><div><a class="primary-cta compact" href="https://github.com/nullskymc/Aurevoy">查看 GitHub <span>↗</span></a><a class="inline-link" href="/dev/develop">开发者文档 →</a></div></div>
          <div class="code-window"><div class="code-title"><span><i></i><i></i><i></i></span><b>agent.config</b></div><pre><code><span class="code-dim">// 选择模型与能力边界</span>
<span class="code-key">provider</span>: <span class="code-string">"openai-compatible"</span>
<span class="code-key">workspace</span>: <span class="code-string">"~/Projects"</span>
<span class="code-key">tools</span>: [
  <span class="code-string">"files"</span>, <span class="code-string">"web"</span>, <span class="code-string">"terminal"</span>
]
<span class="code-key">approval</span>: <span class="code-string">"when-needed"</span>
<span class="code-key">storage</span>: <span class="code-string">"local"</span></code></pre><div class="code-status"><i></i> Ready · all systems local</div></div>
        </div>
      </section>

      <section class="final-cta-section">
        <div class="final-noise" aria-hidden="true"></div>
        <div class="final-orb" aria-hidden="true"></div>
        <div class="final-content" data-reveal>
          <span class="brand-symbol large"><img src="/aurevoy-wordmark.svg" alt="Aurevoy" /></span>
          <p>YOUR NEXT TASK IS READY</p>
          <h2>把下一件事，<br /><em>真正做完。</em></h2>
          <div class="hero-buttons">
            <a class="primary-cta bright" href="https://github.com/nullskymc/Aurevoy/releases">下载 Aurevoy <span>→</span></a>
            <a class="secondary-cta dark" href="/guide/quickstart">5 分钟快速开始</a>
          </div>
          <small>免费 · 开源 · 本地优先 · macOS / Windows / Linux</small>
        </div>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="footer-brand"><a class="landing-brand" href="/"><span class="brand-symbol"><img src="/aurevoy-wordmark.svg" alt="" /></span><span>Aurevoy</span></a><p>运行在你电脑上的个人 AI Agent。</p></div>
      <div class="footer-links"><div><b>产品</b><a href="#product">产品界面</a><a href="#scenes">使用场景</a><a href="#control">安全与控制</a></div><div><b>资源</b><a href="/guide/quickstart">快速开始</a><a href="/guide/introduction">使用指南</a><a href="/ROADMAP">路线图</a></div><div><b>开发</b><a href="/dev/develop">本地开发</a><a href="/ARCHITECTURE">架构</a><a href="https://github.com/nullskymc/Aurevoy">GitHub ↗</a></div></div>
      <div class="footer-bottom"><span>© 2025–present Aurevoy · Created by <a href="https://github.com/nullskymc" target="_blank" rel="noreferrer">nullskymc ↗</a> · MIT License</span><span>Local first. Human in control.</span></div>
    </footer>
  </div>
</template>
