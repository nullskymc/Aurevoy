import { defineConfig } from 'vitepress'

const repo = 'https://github.com/nullskymc/Aurevoy'
/** Custom domain (aurevoy.nullskymc.site) uses root. Override with DOCS_BASE if needed. */
const base = process.env.DOCS_BASE ?? '/'

const userSidebar = [
  {
    text: '开始',
    items: [
      { text: '概览', link: '/guide/introduction' },
      { text: '快速开始', link: '/guide/quickstart' },
    ],
  },
  {
    text: '基础',
    items: [
      { text: '如何写目标', link: '/guide/prompting' },
      { text: '使用习惯', link: '/guide/best-practices' },
      { text: '权限与审批', link: '/guide/permissions' },
    ],
  },
  {
    text: '工作流',
    items: [
      { text: '界面与对话', link: '/guide/interface' },
      { text: '控制任务', link: '/guide/control' },
      { text: '项目与工作台', link: '/guide/projects' },
    ],
  },
  {
    text: '能力',
    items: [
      { text: 'Skill', link: '/guide/skills' },
      { text: '记忆与知识库', link: '/guide/memory' },
      { text: '设置', link: '/guide/settings' },
    ],
  },
  {
    text: '参考',
    items: [
      { text: '故障排查', link: '/guide/troubleshooting' },
    ],
  },
]

const devSidebar = [
  {
    text: '开发者',
    items: [
      { text: '本地开发', link: '/dev/develop' },
      { text: '架构', link: '/ARCHITECTURE' },
      { text: 'API 契约', link: '/API' },
      { text: '技术栈', link: '/TECH_STACK' },
      { text: 'UI 设计', link: '/UI_DESIGN' },
      { text: '开发约定', link: '/CONVENTIONS' },
      { text: '路线图', link: '/ROADMAP' },
    ],
  },
]

export default defineConfig({
  title: 'Aurevoy',
  description: '本地个人 AI Agent。描述目标，在你的电脑上规划、调用工具并完成任务。',
  lang: 'zh-CN',
  base,
  cleanUrls: false,
  lastUpdated: true,
  ignoreDeadLinks: [/^https?:\/\/127\.0\.0\.1/],
  srcExclude: ['README/**'],
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}aurevoy.png` }],
    ['meta', { name: 'theme-color', content: '#3d7a6e' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Aurevoy' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '本地个人 AI Agent。告诉它做什么，不必教它怎么做。',
      },
    ],
    ['meta', { property: 'og:image', content: `${base}aurevoy.png` }],
  ],
  themeConfig: {
    logo: { src: '/aurevoy-wordmark.svg', alt: 'Aurevoy' },
    siteTitle: false,
    nav: [
      { text: '快速开始', link: '/guide/quickstart', activeMatch: '^/guide/quickstart' },
      {
        text: '使用指南',
        link: '/guide/introduction',
        activeMatch: '^/guide/',
      },
      {
        text: '开发者',
        items: [
          { text: '本地开发', link: '/dev/develop' },
          { text: '架构', link: '/ARCHITECTURE' },
          { text: 'API', link: '/API' },
          { text: '技术栈', link: '/TECH_STACK' },
          { text: '开发约定', link: '/CONVENTIONS' },
          { text: '路线图', link: '/ROADMAP' },
        ],
      },
      { text: '下载', link: `${repo}/releases` },
      { text: 'GitHub', link: repo },
    ],
    sidebar: {
      '/guide/': userSidebar,
      '/dev/': devSidebar,
      '/ARCHITECTURE': devSidebar,
      '/API': devSidebar,
      '/TECH_STACK': devSidebar,
      '/UI_DESIGN': devSidebar,
      '/CONVENTIONS': devSidebar,
      '/ROADMAP': devSidebar,
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/dev/docs/:path`,
      text: '在 GitHub 上编辑',
    },
    lastUpdated: {
      text: '更新于',
      formatOptions: { dateStyle: 'medium', timeStyle: undefined },
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },
    outline: { label: '本页', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '浅色',
    darkModeSwitchTitle: '深色',
    footer: {
      message: 'MIT License',
      copyright: '© 2025–present Aurevoy',
    },
  },
  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' },
  },
})
