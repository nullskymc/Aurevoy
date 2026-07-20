import { defineConfig } from 'vitepress'

const repo = 'https://github.com/nullskymc/Aurevoy'
const siteUrl = 'https://aurevoy.nullskymc.site'
/** Custom domain uses root. Override with DOCS_BASE if needed. */
const base = process.env.DOCS_BASE ?? '/'

const siteTitle = 'Aurevoy'
const siteDescription =
  '本地个人 AI Agent 桌面应用。用自然语言描述目标，在本机规划、调用工具并完成任务。开源、可审批、数据默认留在本地。'

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
    items: [{ text: '故障排查', link: '/guide/troubleshooting' }],
  },
]

const devSidebar = [
  {
    text: '开发者',
    items: [
      { text: '本地开发', link: '/dev/develop' },
      { text: '自动更新', link: '/dev/auto-update' },
      { text: '架构', link: '/ARCHITECTURE' },
      { text: 'API 契约', link: '/API' },
      { text: '技术栈', link: '/TECH_STACK' },
      { text: 'UI 设计', link: '/UI_DESIGN' },
      { text: '开发约定', link: '/CONVENTIONS' },
      { text: '路线图', link: '/ROADMAP' },
    ],
  },
]

/** Map VitePress relativePath to public URL path (cleanUrls: false → .html). */
function pagePath(relativePath: string): string {
  let p = relativePath.replace(/\\/g, '/').replace(/\.md$/, '')
  if (p === 'index') return '/'
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length)
  return `/${p}.html`
}

function absoluteUrl(path: string): string {
  if (path === '/') return siteUrl + '/'
  return siteUrl + path
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: siteTitle,
      url: siteUrl + '/',
      description: siteDescription,
      inLanguage: 'zh-CN',
      publisher: {
        '@type': 'Organization',
        name: 'Aurevoy',
        url: siteUrl + '/',
        sameAs: [repo],
      },
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Aurevoy',
      applicationCategory: 'DesktopApplication',
      operatingSystem: 'macOS, Windows, Linux',
      description: siteDescription,
      url: siteUrl + '/',
      downloadUrl: `${repo}/releases`,
      softwareVersion: '0.6.8',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      author: {
        '@type': 'Person',
        name: 'nullskymc',
        url: 'https://github.com/nullskymc',
      },
      license: 'https://opensource.org/licenses/MIT',
      codeRepository: repo,
    },
  ],
}

export default defineConfig({
  title: siteTitle,
  titleTemplate: ':title · Aurevoy',
  description: siteDescription,
  lang: 'zh-CN',
  base,
  cleanUrls: false,
  lastUpdated: true,
  ignoreDeadLinks: [/^https?:\/\/127\.0\.0\.1/],
  srcExclude: ['README/**', 'package.json', 'package-lock.json'],
  sitemap: {
    hostname: siteUrl,
    transformItems: (items) =>
      items.filter(
        (item) =>
          !item.url.includes('/404') &&
          !item.url.includes('package') &&
          !item.url.includes('README'),
      ),
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}aurevoy.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}aurevoy.png` }],
    ['meta', { name: 'theme-color', content: '#3d7a6e' }],
    ['meta', { name: 'author', content: 'nullskymc' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'Aurevoy,AI Agent,本地Agent,个人AI,桌面Agent,开源,Tauri,macOS,MCP,Skill,知识库',
      },
    ],
    ['meta', { name: 'robots', content: 'index,follow,max-image-preview:large' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Aurevoy' }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:title', content: `${siteTitle} · 本地个人 AI Agent` }],
    ['meta', { property: 'og:description', content: siteDescription }],
    ['meta', { property: 'og:url', content: siteUrl + '/' }],
    ['meta', { property: 'og:image', content: `${siteUrl}/aurevoy.png` }],
    ['meta', { property: 'og:image:alt', content: 'Aurevoy' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: `${siteTitle} · 本地个人 AI Agent` }],
    ['meta', { name: 'twitter:description', content: siteDescription }],
    ['meta', { name: 'twitter:image', content: `${siteUrl}/aurevoy.png` }],
    ['link', { rel: 'canonical', href: siteUrl + '/' }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify(jsonLd),
    ],
  ],
  transformPageData(pageData) {
    const path = pagePath(pageData.relativePath)
    const url = absoluteUrl(path)
    const title = pageData.frontmatter.title || pageData.title || siteTitle
    const description =
      (pageData.frontmatter.description as string | undefined) ||
      pageData.description ||
      siteDescription
    const isHome = pageData.relativePath === 'index.md'
    const displayTitle = isHome
      ? `${siteTitle} · 本地个人 AI Agent`
      : `${title} · Aurevoy`

    const prev = (pageData.frontmatter.head ?? []) as Array<
      [string, Record<string, string>, string?]
    >
    const kept = prev.filter((h) => {
      const a = h?.[1]
      if (!a) return true
      if (a.rel === 'canonical') return false
      if (a.property?.startsWith('og:')) return false
      if (a.name?.startsWith('twitter:') || a.name === 'description') return false
      return true
    })

    pageData.frontmatter.head = [
      ...kept,
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: displayTitle }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:type', content: isHome ? 'website' : 'article' }],
      ['meta', { property: 'og:image', content: `${siteUrl}/aurevoy.png` }],
      ['meta', { name: 'twitter:title', content: displayTitle }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: `${siteUrl}/aurevoy.png` }],
      ['meta', { name: 'description', content: description }],
    ]
  },
  themeConfig: {
    logo: { src: '/aurevoy-wordmark.svg', alt: 'Aurevoy' },
    siteTitle: false,
    nav: [
      { text: '产品', link: '/#capabilities' },
      { text: '工作方式', link: '/#workflow' },
      { text: '安全控制', link: '/#control' },
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
          { text: '自动更新', link: '/dev/auto-update' },
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
